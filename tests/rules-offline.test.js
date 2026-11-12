'use strict';
// Testes das regras sem depender de conexão externa ou de node_modules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const file = path.join(__dirname, '..', 'server.js');
let uniqueId = 0;
class FakeServer {
  constructor() {
    this.sockets = { sockets: new Map() };
    this.groups = new Map();
    this.handlers = {};
  }
  on(event, handler) { this.handlers[event] = handler; }
  to(group) {
    return { emit: (event, payload) => {
      for (const sock of this.sockets.sockets.values()) {
        if (sock.groups.has(group)) sock.emit(event, payload);
      }
    }};
  }
  connect() {
    const socket = new FakeSocket(this, 'fake' + (++uniqueId));
    this.sockets.sockets.set(socket.id, socket);
    this.handlers.connection(socket);
    return socket;
  }
}
class FakeSocket {
  constructor(io, id) { this.io = io; this.id = id; this.handlers = {}; this.groups = new Set(); this.data = {}; this.notifications = []; }
  on(name, handler) { this.handlers[name] = handler; }
  emit(name, payload) { this.notifications.push([name, payload]); }
  join(group) { this.groups.add(group); }
  leave(group) { this.groups.delete(group); }
  disconnect() { this.handlers.disconnect?.(); this.io.sockets.sockets.delete(this.id); }
  send(name, payload) {
    let outcome;
    this.handlers[name](payload, value => { outcome = value; });
    assert.ok(outcome, `Servidor não respondeu ao evento ${name}`);
    return outcome;
  }
}
function createApp() {
  const app = () => {};
  app.disable = () => {};
  app.use = () => {};
  app.get = () => {};
  return app;
}
createApp.static = () => () => {};
function loadServer() {
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m.require = id => {
    if (id === 'express') return createApp;
    if (id === 'socket.io') return { Server: FakeServer };
    return require(id);
  };
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}
function roomWithThree(server) {
  const ana = server.io.connect();
  const bruno = server.io.connect();
  const carla = server.io.connect();
  const a = ana.send('createRoom', { name: 'Ana' });
  const b = bruno.send('joinRoom', { code: a.code, name: 'Bruno' });
  const c = carla.send('joinRoom', { code: a.code, name: 'Carla' });
  assert.ok(a.ok && b.ok && c.ok);
  const room = server.rooms.get(a.code);
  return { ana, bruno, carla, a, b, c, room };
}

test('ao remover quem vai chutar, a vez passa ao próximo em ordem circular', () => {
  const server = loadServer();
  const { ana, bruno, carla, a, b, c, room } = roomWithThree(server);
  assert.ok(ana.send('action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' }).ok);
  assert.ok(ana.send('action', { action: 'reveal', index: 3 }).ok);
  assert.deepEqual(room.guessOrder, [a.playerId, b.playerId, c.playerId]);
  assert.ok(ana.send('action', { action: 'guess', guess: 'Verde' }).ok);
  assert.equal(room.guessOrder[room.guessIndex], b.playerId);
  assert.ok(ana.send('kickPlayer', { playerId: b.playerId }).ok);
  assert.deepEqual(room.guessOrder, [a.playerId, c.playerId]);
  assert.equal(room.guessOrder[room.guessIndex], c.playerId);
  assert.equal(bruno.notifications.at(-1)[0], 'removedFromRoom');
  assert.equal(bruno.send('action', { action: 'guess', guess: 'Azul' }).ok, false);
  assert.equal(bruno.send('joinRoom', { code: a.code, name: 'Bruno', token: b.token }).ok, false);
  assert.equal(bruno.send('joinRoom', { code: a.code, name: 'Bruno' }).ok, false);
  assert.ok(carla.send('action', { action: 'guess', guess: 'Azul' }).ok);
  assert.equal(room.phase, 'ended');
  assert.equal(room.players[1].score, 1);
});

test('remover quem já chutou mantém sequência e próximo pedido', () => {
  const server = loadServer();
  const { ana, bruno, carla, b, c, room } = roomWithThree(server);
  ana.send('action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' });
  ana.send('action', { action: 'reveal', index: 2 });
  ana.send('action', { action: 'skipGuess' });
  bruno.send('action', { action: 'skipGuess' });
  assert.equal(room.guessOrder[room.guessIndex], c.playerId);
  assert.ok(ana.send('kickPlayer', { playerId: b.playerId }).ok);
  assert.equal(room.guessOrder[room.guessIndex], c.playerId);
  carla.send('action', { action: 'skipGuess' });
  assert.equal(room.phase, 'pick');
  assert.equal(room.players[room.turnIndex].id, c.playerId);
});

test('se anfitrião sair durante palpite, cargo e escolha passam corretamente', () => {
  const server = loadServer();
  const { ana, bruno, carla, a, b, c, room } = roomWithThree(server);
  ana.send('action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' });
  ana.send('action', { action: 'reveal', index: 2 });
  assert.ok(ana.send('leaveRoom', {}).ok);
  assert.equal(room.players.length, 2);
  assert.equal(room.hostId, b.playerId);
  assert.equal(room.guessOrder[room.guessIndex], b.playerId);
  assert.equal(ana.send('action', { action: 'skipGuess' }).ok, false);
  bruno.send('action', { action: 'skipGuess' });
  carla.send('action', { action: 'skipGuess' });
  assert.equal(room.phase, 'pick');
  assert.equal(room.players[room.turnIndex].id, b.playerId);
  bruno.send('action', { action: 'reveal', index: 1 });
  assert.deepEqual(room.guessOrder, [b.playerId, c.playerId]);
});

test('remover o participante que acabou de pedir a dica não salta o próximo', () => {
  const server = loadServer();
  const { ana, bruno, carla, b, room } = roomWithThree(server);
  ana.send('action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' });
  // Ana pode sair (host) durante a fase de escolha.
  ana.send('leaveRoom', {});
  assert.equal(room.players[room.turnIndex].id, b.playerId);
  assert.ok(bruno.send('action', { action: 'reveal', index: 0 }).ok);
  assert.equal(room.guessOrder[0], b.playerId);
  assert.equal(room.guessOrder.length, 2);
});

test('sair como último jogador apaga sala; encerrar notifica todos', () => {
  const server = loadServer();
  const { ana, bruno, carla, a, room } = roomWithThree(server);
  assert.equal(bruno.send('closeRoom', {}).ok, false);
  assert.equal(carla.send('kickPlayer', { playerId: a.playerId }).ok, false);
  assert.equal(ana.send('kickPlayer', { playerId: a.playerId }).ok, false);
  assert.ok(ana.send('closeRoom', {}).ok);
  assert.equal(server.rooms.has(a.code), false);
  for (const client of [ana, bruno, carla]) {
    assert.ok(client.notifications.some(([event]) => event === 'roomClosed'));
    assert.equal(client.send('leaveRoom', {}).ok, false);
  }
  assert.equal(bruno.send('joinRoom', { code: a.code, name: 'Bruno' }).ok, false);
  const only = server.io.connect();
  const solo = only.send('createRoom', { name: 'Solo' });
  assert.ok(only.send('leaveRoom', {}).ok);
  assert.equal(server.rooms.has(solo.code), false);
});

test('host pode remover participante ausente e evitar retorno pelo token', () => {
  const server = loadServer();
  const { ana, bruno, a, b, room } = roomWithThree(server);
  bruno.disconnect();
  assert.equal(room.players.find(p => p.id === b.playerId).connected, false);
  assert.ok(ana.send('kickPlayer', { playerId: b.playerId }).ok);
  const reconnect = server.io.connect();
  assert.equal(reconnect.send('joinRoom', { code: a.code, name: 'Bruno', token: b.token }).ok, false);
});

test('quando o anfitrião sai na sala de espera, outro recebe o cargo e pode iniciar', () => {
  const server = loadServer();
  const { ana, bruno, b, room } = roomWithThree(server);
  assert.ok(ana.send('leaveRoom', {}).ok);
  assert.equal(room.hostId, b.playerId);
  assert.ok(bruno.send('action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' }).ok);
  assert.equal(room.phase, 'pick');
  assert.equal(room.players[room.turnIndex].id, b.playerId);
});

test('solo continua após outra pessoa sair e todos os palpites terem acabado', () => {
  const server = loadServer();
  const { ana, bruno, carla, a, room } = roomWithThree(server);
  ana.send('action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' });
  ana.send('action', { action: 'reveal', index: 2 });
  assert.ok(ana.send('kickPlayer', { playerId: room.players[2].id }).ok);
  assert.ok(bruno.send('leaveRoom', {}).ok);
  assert.equal(room.players.length, 1);
  assert.equal(room.guessOrder.length, 1);
  assert.equal(room.guessOrder[room.guessIndex], a.playerId);
  assert.ok(ana.send('action', { action: 'skipGuess' }).ok);
  assert.equal(room.phase, 'pick');
  assert.equal(room.players[room.turnIndex].id, a.playerId);
  assert.ok(ana.send('action', { action: 'reveal', index: 3 }).ok);
  assert.equal(room.guessOrder.length, 1);
});

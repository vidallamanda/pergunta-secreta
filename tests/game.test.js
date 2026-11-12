'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: client } = require('socket.io-client');
const { httpServer, io, rooms } = require('../server');

const sockets = [];
let baseUrl = null;

async function setup() {
  if (baseUrl) return baseUrl;
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + httpServer.address().port;
  return baseUrl;
}
async function connect() {
  await setup();
  const socket = client(baseUrl, { forceNew: true, transports: ['polling', 'websocket'], reconnection: false });
  sockets.push(socket);
  if (!socket.connected) await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}
function send(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}

after(async () => {
  for (const socket of sockets) socket.disconnect();
  await new Promise(resolve => io.close(resolve));
});

test('dois computadores: revela palavra para todos e palpite em ordem circular', async () => {
  const ana = await connect();
  const bruno = await connect();
  const carla = await connect();
  const created = await send(ana, 'createRoom', { name: 'Ana' });
  assert.equal(created.ok, true);
  const code = created.code;
  const joinedB = await send(bruno, 'joinRoom', { code, name: 'Bruno' });
  const joinedC = await send(carla, 'joinRoom', { code, name: 'Carla' });
  assert.equal(joinedB.ok, true);
  assert.equal(joinedC.ok, true);
  let room = rooms.get(code);
  assert.equal(room.players.length, 3);

  assert.equal((await send(ana, 'action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' })).ok, true);
  assert.equal(room.phase, 'pick');
  assert.equal(room.turnIndex, 0);
  assert.equal((await send(bruno, 'action', { action: 'reveal', index: 0 })).ok, false, 'Somente quem está na vez revela');
  assert.equal((await send(ana, 'action', { action: 'reveal', index: 2 })).ok, true);
  assert.equal(room.revealed[2], 'a');
  assert.equal(room.guessOrder.join(','), [created.playerId, joinedB.playerId, joinedC.playerId].join(','));
  assert.equal((await send(ana, 'action', { action: 'guess', guess: 'Vermelho' })).ok, true);
  assert.equal(room.guessIndex, 1);
  assert.equal((await send(bruno, 'action', { action: 'guess', guess: 'Azul' })).ok, true);
  assert.equal(room.phase, 'ended');
  assert.equal(room.players[1].score, 1);
  const state = joinedC.state;
  assert.equal(state.question, undefined, 'A pergunta não é enviada aos clientes durante a rodada');

  assert.equal((await send(ana, 'action', { action: 'nextRound' })).ok, true);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.turnIndex, 1);
  assert.equal((await send(ana, 'action', { action: 'start', mode: 'custom', question: 'Qual é a capital do Brasil?', answer: 'Brasília | Brasilia' })).ok, true);
  assert.equal((await send(bruno, 'action', { action: 'reveal', index: 1 })).ok, true);
  assert.deepEqual(room.guessOrder, [joinedB.playerId, joinedC.playerId, created.playerId]);
  assert.equal((await send(bruno, 'action', { action: 'skipGuess' })).ok, true);
  assert.equal((await send(carla, 'action', { action: 'skipGuess' })).ok, true);
  assert.equal((await send(ana, 'action', { action: 'skipGuess' })).ok, true);
  assert.equal(room.phase, 'pick');
  assert.equal(room.turnIndex, 2);
  assert.equal((await send(carla, 'action', { action: 'reveal', index: 2 })).ok, true);
  assert.deepEqual(room.guessOrder, [joinedC.playerId, created.playerId, joinedB.playerId]);
});

test('modo solo: após errar, pode revelar outra palavra', async () => {
  const solo = await connect();
  const welcome = await send(solo, 'createRoom', { name: 'Jogador solo' });
  const room = rooms.get(welcome.code);
  assert.equal((await send(solo, 'action', { action: 'start', mode: 'custom', question: 'Quanto é dois mais dois?', answer: 'Quatro | 4' })).ok, true);
  assert.equal((await send(solo, 'action', { action: 'reveal', index: 0 })).ok, true);
  assert.equal(room.guessOrder.length, 1);
  assert.equal((await send(solo, 'action', { action: 'guess', guess: 'Cinco' })).ok, true);
  assert.equal(room.phase, 'pick');
  assert.equal((await send(solo, 'action', { action: 'reveal', index: 1 })).ok, true);
  assert.equal((await send(solo, 'action', { action: 'guess', guess: '4' })).ok, true);
  assert.equal(room.players[0].score, 1);
  assert.equal(room.phase, 'ended');
});

test('reconexão com token preserva o participante e os pontos', async () => {
  const ana = await connect();
  const welcome = await send(ana, 'createRoom', { name: 'Ana' });
  const room = rooms.get(welcome.code);
  ana.disconnect();
  const newer = await connect();
  const joined = await send(newer, 'joinRoom', { code: welcome.code, name: 'Ana', token: welcome.token });
  assert.equal(joined.playerId, welcome.playerId);
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].connected, true);
});

test('anfitrião remove jogador no meio dos palpites, sem pular o próximo', async () => {
  const ana = await connect();
  const bruno = await connect();
  const carla = await connect();
  const a = await send(ana, 'createRoom', { name: 'Ana' });
  const b = await send(bruno, 'joinRoom', { code: a.code, name: 'Bruno' });
  const c = await send(carla, 'joinRoom', { code: a.code, name: 'Carla' });
  const room = rooms.get(a.code);
  assert.equal((await send(ana, 'action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' })).ok, true);
  assert.equal((await send(ana, 'action', { action: 'reveal', index: 1 })).ok, true);
  assert.equal((await send(ana, 'action', { action: 'guess', guess: 'Rosa' })).ok, true);
  assert.equal(room.guessOrder[room.guessIndex], b.playerId);
  const removed = new Promise(resolve => bruno.once('removedFromRoom', resolve));
  assert.equal((await send(ana, 'kickPlayer', { playerId: b.playerId })).ok, true);
  assert.match((await removed).message, /removeu/);
  assert.deepEqual(room.guessOrder, [a.playerId, c.playerId]);
  assert.equal(room.guessOrder[room.guessIndex], c.playerId);
  assert.equal(room.players.length, 2);
  assert.equal((await send(bruno, 'action', { action: 'guess', guess: 'Azul' })).ok, false);
  assert.equal((await send(bruno, 'joinRoom', { code: a.code, token: b.token, name: 'Bruno' })).ok, false);
  assert.equal((await send(carla, 'action', { action: 'guess', guess: 'Azul' })).ok, true);
  assert.equal(room.phase, 'ended');
  assert.equal(room.players.find(p => p.id === c.playerId).score, 1);
});

test('remover o próximo a escolher palavra mantém o turno circular', async () => {
  const ana = await connect();
  const bruno = await connect();
  const carla = await connect();
  const a = await send(ana, 'createRoom', { name: 'Ana' });
  const b = await send(bruno, 'joinRoom', { code: a.code, name: 'Bruno' });
  const c = await send(carla, 'joinRoom', { code: a.code, name: 'Carla' });
  const room = rooms.get(a.code);
  assert.equal((await send(ana, 'action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' })).ok, true);
  assert.equal((await send(ana, 'kickPlayer', { playerId: b.playerId })).ok, true);
  assert.equal((await send(ana, 'action', { action: 'reveal', index: 0 })).ok, true);
  assert.deepEqual(room.guessOrder, [a.playerId, c.playerId]);
  await send(ana, 'action', { action: 'skipGuess' });
  await send(carla, 'action', { action: 'skipGuess' });
  assert.equal(room.phase, 'pick');
  assert.equal(room.players[room.turnIndex].id, c.playerId);
  assert.equal((await send(carla, 'action', { action: 'reveal', index: 1 })).ok, true);
  assert.deepEqual(room.guessOrder, [c.playerId, a.playerId]);
});

test('sair durante os palpites transfere anfitrião e preserva próxima vez', async () => {
  const ana = await connect();
  const bruno = await connect();
  const carla = await connect();
  const a = await send(ana, 'createRoom', { name: 'Ana' });
  const b = await send(bruno, 'joinRoom', { code: a.code, name: 'Bruno' });
  const c = await send(carla, 'joinRoom', { code: a.code, name: 'Carla' });
  const room = rooms.get(a.code);
  await send(ana, 'action', { action: 'start', mode: 'custom', question: 'Qual é a cor do céu?', answer: 'Azul' });
  await send(ana, 'action', { action: 'reveal', index: 1 });
  assert.equal((await send(ana, 'leaveRoom', {})).ok, true);
  assert.equal(room.players.length, 2);
  assert.equal(room.hostId, b.playerId);
  assert.equal(room.guessOrder[room.guessIndex], b.playerId);
  assert.equal((await send(ana, 'action', { action: 'guess', guess: 'Azul' })).ok, false);
  await send(bruno, 'action', { action: 'skipGuess' });
  await send(carla, 'action', { action: 'skipGuess' });
  assert.equal(room.phase, 'pick');
  assert.equal(room.players[room.turnIndex].id, b.playerId);
  assert.equal((await send(bruno, 'action', { action: 'reveal', index: 2 })).ok, true);
  assert.deepEqual(room.guessOrder, [b.playerId, c.playerId]);
});

test('somente anfitrião encerra a sala e código fica inválido', async () => {
  const ana = await connect();
  const bruno = await connect();
  const a = await send(ana, 'createRoom', { name: 'Ana' });
  await send(bruno, 'joinRoom', { code: a.code, name: 'Bruno' });
  assert.equal((await send(bruno, 'closeRoom', {})).ok, false);
  const closed = new Promise(resolve => bruno.once('roomClosed', resolve));
  assert.equal((await send(ana, 'closeRoom', {})).ok, true);
  assert.match((await closed).message, /encerrou/);
  assert.equal(rooms.has(a.code), false);
  assert.equal((await send(bruno, 'joinRoom', { code: a.code, name: 'Bruno' })).ok, false);
});

test('sair sozinho encerra sala e convidado não pode remover o anfitrião', async () => {
  const ana = await connect();
  const bruno = await connect();
  const a = await send(ana, 'createRoom', { name: 'Ana' });
  const b = await send(bruno, 'joinRoom', { code: a.code, name: 'Bruno' });
  assert.equal((await send(bruno, 'kickPlayer', { playerId: a.playerId })).ok, false);
  assert.equal((await send(ana, 'kickPlayer', { playerId: a.playerId })).ok, false);
  assert.equal((await send(bruno, 'leaveRoom', {})).ok, true);
  assert.equal(rooms.get(a.code).players.length, 1);
  assert.equal((await send(ana, 'leaveRoom', {})).ok, true);
  assert.equal(rooms.has(a.code), false);
});

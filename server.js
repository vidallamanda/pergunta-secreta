'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { transports: ['polling', 'websocket'], maxHttpBufferSize: 65536, pingInterval: 25000, pingTimeout: 20000 });
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get('/health', (_, res) => res.json({ ok: true }));

const QUESTIONS = [
  ['Qual planeta do Sistema Solar é conhecido como planeta vermelho?', 'Marte'],
  ['Qual é o maior oceano do planeta Terra?', 'Pacífico | Oceano Pacífico'],
  ['Qual país abriga a famosa cidade de Kyoto?', 'Japão'],
  ['Qual instrumento musical possui teclas brancas e pretas?', 'Piano'],
  ['Qual animal é conhecido pelo pescoço muito comprido?', 'Girafa'],
  ['Em qual continente fica o deserto do Saara?', 'África'],
  ['Qual elemento químico é representado pelo símbolo Au?', 'Ouro'],
  ['Quem escreveu o romance Dom Casmurro?', 'Machado de Assis'],
  ['Qual cientista formulou a teoria da relatividade?', 'Albert Einstein | Einstein'],
  ['Qual é o nome do satélite natural da Terra?', 'Lua'],
  ['Em qual país foram construídas as pirâmides de Gizé?', 'Egito'],
  ['Qual é o nome da estrela mais próxima da Terra?', 'Sol'],
  ['Qual é a capital do estado do Rio Grande do Sul?', 'Porto Alegre'],
  ['Qual processo permite às plantas produzir alimento usando a luz solar?', 'Fotossíntese'],
  ['Qual ave é conhecida por imitar a fala humana?', 'Papagaio'],
  ['Qual é a moeda oficial do Japão?', 'Iene'],
  ['Qual é o esporte praticado em uma quadra com uma cesta e uma bola?', 'Basquete | Basketball'],
  ['Qual país é famoso pela Torre Eiffel?', 'França'],
  ['Qual é o maior mamífero vivo do planeta?', 'Baleia-azul | Baleia azul'],
  ['Como se chama a figura geométrica com três lados?', 'Triângulo'],
  ['Qual personagem da mitologia grega tinha asas de cera?', 'Ícaro'],
  ['Em qual cidade brasileira fica o Cristo Redentor?', 'Rio de Janeiro'],
  ['Qual planeta do Sistema Solar possui anéis mais famosos?', 'Saturno'],
  ['Qual órgão do corpo humano bombeia o sangue?', 'Coração'],
  ['Que instrumento usamos para medir a temperatura?', 'Termômetro'],
  ['Qual é a capital da Argentina?', 'Buenos Aires'],
  ['Qual gás as plantas absorvem durante a fotossíntese?', 'Dióxido de carbono | Gás carbônico | CO2'],
  ['Como se chama o resultado de multiplicar dois números?', 'Produto'],
  ['Qual esporte usa uma raquete e uma peteca?', 'Badminton'],
  ['Qual artista pintou a Mona Lisa?', 'Leonardo da Vinci | Da Vinci']
];

const rooms = new Map();
const MAX_PLAYERS = 12;
const MAX_ROOMS = 400;
const ROOM_TTL = 4 * 60 * 60 * 1000;
const NAME_PATTERN = /\S/;
const ROOM_CHANNEL = code => 'room:' + code;
const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
const shorten = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const wordsOf = q => q.trim().match(/\S+/g) || [];
const genToken = () => crypto.randomBytes(24).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => Array.from(crypto.randomBytes(7), x => CODE_CHARS[x % CODE_CHARS.length]).join('');
const ok = (ack, result) => typeof ack === 'function' && ack({ ok: true, ...result });
const fail = (ack, message) => typeof ack === 'function' && ack({ ok: false, message });

function createCode() {
  for (let i = 0; i < 50; i++) {
    const code = genCode();
    if (!rooms.has(code)) return code;
  }
  throw new Error('Sem códigos de sala disponíveis.');
}
function addLog(room, message) {
  room.events.unshift(message);
  room.events = room.events.slice(0, 14);
}
function player(room, id) { return room.players.find(p => p.id === id); }
function connected(room, id) { return Boolean(player(room, id)?.connected); }
function nameOf(room, id) { return player(room, id)?.name || 'Participante'; }
function currentPicker(room) { return room.players[room.turnIndex]; }
function nextConnectedIndex(room, current) {
  if (!room.players.length) return 0;
  for (let n = 1; n <= room.players.length; n++) {
    const index = (current + n) % room.players.length;
    if (room.players[index].connected) return index;
  }
  return current;
}
function advanceGuess(room) {
  room.guessIndex++;
  while (room.guessIndex < room.guessOrder.length && !connected(room, room.guessOrder[room.guessIndex])) room.guessIndex++;
  if (room.guessIndex < room.guessOrder.length) return;
  if (Object.keys(room.revealed).length === room.wordCount) {
    endRound(room, null);
    return;
  }
  room.phase = 'pick';
  room.turnIndex = nextConnectedIndex(room, room.turnIndex);
  room.guessOrder = [];
  room.guessIndex = 0;
  addLog(room, `Agora ${nameOf(room, currentPicker(room)?.id)} escolhe uma palavra.`);
}
function endRound(room, winnerId) {
  room.phase = 'ended';
  room.result = { winnerId, question: room.question, answer: room.answer.split('|')[0].trim() };
  room.guessOrder = [];
  room.guessIndex = 0;
  if (winnerId) addLog(room, `${nameOf(room, winnerId)} acertou e ganhou 1 ponto!`);
  else addLog(room, 'Ninguém acertou a pergunta.');
}
function publicState(room) {
  return {
    phase: room.phase, round: room.round,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
    hostId: room.hostId, turnIndex: room.turnIndex, guessOrder: room.guessOrder,
    guessIndex: room.guessIndex, wordCount: room.wordCount,
    revealed: room.revealed, events: room.events, result: room.result
  };
}
function publish(room) {
  room.lastActivity = Date.now();
  io.to(ROOM_CHANNEL(room.code)).emit('roomState', publicState(room));
}
function releaseCurrentSocket(socket) {
  const session = socket.data.session;
  if (!session) return;
  socket.leave(ROOM_CHANNEL(session.roomCode));
  socket.data.session = null;
  const room = rooms.get(session.roomCode);
  const p = room && player(room, session.playerId);
  if (!room || !p || p.socketId !== socket.id) return;
  p.connected = false;
  p.socketId = null;
  addLog(room, `${p.name} desconectou.`);
  if (room.phase === 'pick' && currentPicker(room)?.id === p.id) room.turnIndex = nextConnectedIndex(room, room.turnIndex);
  if (room.phase === 'guess' && room.guessOrder[room.guessIndex] === p.id) advanceGuess(room);
  if (room.hostId === p.id) {
    const expectedHostId = p.id;
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      if (room.hostId !== expectedHostId || connected(room, expectedHostId)) return;
      const replacement = room.players.find(x => x.connected);
      if (replacement) {
        room.hostId = replacement.id;
        addLog(room, `${replacement.name} assumiu como anfitrião.`);
        publish(room);
      }
    }, 12000);
    room.hostTimer.unref?.();
  }
  publish(room);
}
function bindPlayer(socket, room, p) {
  const existing = p.socketId && io.sockets.sockets.get(p.socketId);
  if (existing && existing.id !== socket.id) {
    existing.emit('sessionReplaced');
    existing.data.session = null;
    existing.leave(ROOM_CHANNEL(room.code));
    existing.disconnect(true);
  }
  releaseCurrentSocket(socket);
  p.socketId = socket.id;
  p.connected = true;
  socket.join(ROOM_CHANNEL(room.code));
  socket.data.session = { roomCode: room.code, playerId: p.id };
  if (room.phase === 'pick' && !currentPicker(room)?.connected) room.turnIndex = room.players.indexOf(p);
  if (room.hostTimer && room.hostId === p.id) clearTimeout(room.hostTimer);
}
function getSession(socket) {
  const session = socket.data.session;
  const room = session && rooms.get(session.roomCode);
  const p = room && player(room, session.playerId);
  if (!room || !p || p.socketId !== socket.id || !p.connected) return null;
  return { room, p };
}
function handleAction(room, p, payload) {
  const action = payload?.action;
  if (action === 'start') {
    if (room.hostId !== p.id || (room.phase !== 'lobby' && room.phase !== 'ended')) return 'Só o anfitrião pode começar a rodada.';
    let question, answer;
    if (payload.mode === 'custom') {
      question = shorten(payload.question, 320);
      answer = shorten(payload.answer, 180);
      if (!question || !answer || wordsOf(question).length < 2) return 'Preencha a pergunta com pelo menos duas palavras e informe a resposta.';
    } else {
      if (room.asked.size >= QUESTIONS.length) room.asked.clear();
      const available = QUESTIONS.map((_, i) => i).filter(i => !room.asked.has(i));
      const i = available[crypto.randomInt(available.length)];
      room.asked.add(i);
      [question, answer] = QUESTIONS[i];
    }
    room.question = question;
    room.answer = answer;
    room.wordTokens = wordsOf(question);
    room.wordCount = room.wordTokens.length;
    room.round++;
    room.phase = 'pick';
    room.revealed = {};
    room.guessOrder = [];
    room.guessIndex = 0;
    room.result = null;
    if (!connected(room, currentPicker(room)?.id)) room.turnIndex = nextConnectedIndex(room, room.turnIndex);
    addLog(room, `Rodada ${room.round} iniciada. Pergunta escondida!`);
    return null;
  }
  if (action === 'nextRound') {
    if (room.hostId !== p.id || room.phase !== 'ended') return 'Apenas o anfitrião pode preparar a próxima rodada.';
    room.phase = 'lobby';
    room.turnIndex = nextConnectedIndex(room, room.turnIndex);
    room.wordCount = 0; room.wordTokens = []; room.answer = ''; room.question = '';
    room.revealed = {}; room.result = null; room.guessOrder = []; room.guessIndex = 0;
    addLog(room, 'Preparando uma nova rodada.');
    return null;
  }
  if (action === 'reveal' && room.phase === 'pick' && currentPicker(room)?.id === p.id) {
    const i = Number(payload.index);
    if (!Number.isInteger(i) || i < 0 || i >= room.wordCount || Object.hasOwn(room.revealed, String(i))) return 'Esta palavra não está disponível.';
    room.revealed[i] = room.wordTokens[i];
    room.phase = 'guess';
    room.guessOrder = room.players.slice(room.turnIndex).concat(room.players.slice(0, room.turnIndex)).filter(x => x.connected).map(x => x.id);
    room.guessIndex = 0;
    addLog(room, `${p.name} pediu a palavra ${i + 1}: ${room.wordTokens[i]}`);
    return null;
  }
  if (action === 'skipPick' && room.phase === 'pick' && currentPicker(room)?.id === p.id && room.players.filter(x => x.connected).length > 1) {
    room.turnIndex = nextConnectedIndex(room, room.turnIndex);
    addLog(room, `${p.name} passou a vez de pedir dica.`);
    return null;
  }
  if ((action === 'guess' || action === 'skipGuess') && room.phase === 'guess' && room.guessOrder[room.guessIndex] === p.id) {
    if (action === 'skipGuess') {
      addLog(room, `${p.name} passou o palpite.`);
      advanceGuess(room);
      return null;
    }
    const guess = shorten(payload.guess, 120);
    if (!normalize(guess)) return 'Informe um palpite válido.';
    const correct = room.answer.split('|').some(x => normalize(x) === normalize(guess));
    if (correct) { p.score++; endRound(room, p.id); }
    else { addLog(room, `${p.name} tentou “${guess}” e não acertou.`); advanceGuess(room); }
    return null;
  }
  return 'Ainda não é a sua vez ou a ação não está disponível.';
}

io.on('connection', socket => {
  socket.on('createRoom', (data, ack) => {
    const name = shorten(data?.name, 24);
    if (!NAME_PATTERN.test(name)) return fail(ack, 'Informe seu nome.');
    if (rooms.size >= MAX_ROOMS) return fail(ack, 'Muitas salas ativas no momento.');
    const code = createCode();
    const p = { id: crypto.randomUUID(), name, score: 0, token: genToken(), connected: false, socketId: null };
    const room = { code, hostId: p.id, players: [p], phase: 'lobby', round: 0, turnIndex: 0, guessOrder: [], guessIndex: 0,
      wordCount: 0, wordTokens: [], question: '', answer: '', revealed: {}, result: null,
      events: ['Sala criada. Compartilhe o link com seus colegas.'], asked: new Set(), lastActivity: Date.now(), hostTimer: null };
    rooms.set(code, room);
    bindPlayer(socket, room, p);
    ok(ack, { code, playerId: p.id, token: p.token, name: p.name, hostId: room.hostId, state: publicState(room) });
    publish(room);
  });
  socket.on('joinRoom', (data, ack) => {
    const code = shorten(data?.code, 14).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = shorten(data?.name, 24);
    const token = shorten(data?.token, 128);
    const room = rooms.get(code);
    if (!room) return fail(ack, 'Sala não encontrada. Confira o código. Se o servidor reiniciou, é necessário criar outra sala.');
    let p = token && room.players.find(x => x.token === token);
    if (!p) {
      if (room.phase !== 'lobby') return fail(ack, 'A partida já começou. Só é possível entrar numa nova sala antes de começar a rodada.');
      if (!NAME_PATTERN.test(name)) return fail(ack, 'Informe seu nome.');
      if (room.players.length >= MAX_PLAYERS) return fail(ack, 'A sala está cheia (máximo de 12 participantes).');
      if (room.players.some(x => normalize(x.name) === normalize(name))) return fail(ack, 'Esse nome já está em uso. Escolha outro.');
      p = { id: crypto.randomUUID(), name, token: genToken(), score: 0, connected: false, socketId: null };
      room.players.push(p);
      addLog(room, `${p.name} entrou na sala.`);
    } else addLog(room, `${p.name} voltou para a sala.`);
    bindPlayer(socket, room, p);
    ok(ack, { code: room.code, playerId: p.id, token: p.token, name: p.name, hostId: room.hostId, state: publicState(room) });
    publish(room);
  });
  socket.on('action', (data, ack) => {
    const session = getSession(socket);
    if (!session) return fail(ack, 'A sessão expirou. Recarregue a página e entre novamente.');
    const message = handleAction(session.room, session.p, data);
    if (message) return fail(ack, message);
    ok(ack, {});
    publish(session.room);
  });
  socket.on('disconnect', () => releaseCurrentSocket(socket));
});

const cleanRooms = setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.lastActivity > ROOM_TTL && !room.players.some(x => x.connected)) {
      clearTimeout(room.hostTimer);
      rooms.delete(code);
    }
  }
}, 60000);
cleanRooms.unref?.();

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  httpServer.listen(port, '0.0.0.0', () => console.log(`Jogo em http://localhost:${port}`));
}
module.exports = { app, httpServer, io, rooms, handleAction, publicState };

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (s, n = 24) => String(s || '').trim().slice(0, n);
  const invitation = () => { const url = new URL(location.href); url.searchParams.set('sala', roomCode); url.hash = ''; return url.href; };
  const savedKey = 'ps-v2-current-session';
  let socket = null, session = null, state = null, myPlayerId = '', roomCode = '', isHost = false;
  let ready = false, connecting = false, reconnecting = false;
  const queryRoom = new URLSearchParams(location.search).get('sala');
  const urlCode = String(queryRoom || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);

  function showError(where, message) { $(where).textContent = message; $(where).hidden = !message; }
  function online(text, tone = '') { $('network-status').textContent = text; $('network-status').className = 'online ' + tone; }
  function showRoom() {
    $('start-view').hidden = true;
    $('room-view').hidden = false;
    $('room-code-label').textContent = roomCode;
    document.title = `Sala ${roomCode} | Pergunta Secreta`;
    history.replaceState(null, '', `${location.pathname}?sala=${roomCode}`);
  }
  function saveSession(welcome) {
    session = { code: welcome.code, name: welcome.name, token: welcome.token, playerId: welcome.playerId };
    try { sessionStorage.setItem(savedKey, JSON.stringify(session)); } catch (_) { /* storage opcional */ }
    roomCode = welcome.code;
    myPlayerId = welcome.playerId;
    state = welcome.state;
    isHost = state.hostId === myPlayerId;
    connecting = false;
    ready = true;
    reconnecting = false;
    online('Sala conectada', 'ok');
    showRoom();
    $('connection-warning').hidden = true;
    showError('start-error', '');
    render();
  }
  function getSaved() {
    try { const s = JSON.parse(sessionStorage.getItem(savedKey)); return s?.code && s?.token ? s : null; }
    catch { return null; }
  }
  function clearSaved() { session = null; try { sessionStorage.removeItem(savedKey); } catch (_) {} }
  function backToStart(message) {
    ready = false;
    connecting = false;
    reconnecting = false;
    state = null;
    myPlayerId = '';
    roomCode = '';
    isHost = false;
    clearSaved();
    $('room-view').hidden = true;
    $('start-view').hidden = false;
    $('connection-warning').hidden = true;
    $('feedback').textContent = '';
    $('join-code').value = '';
    document.title = 'Pergunta Secreta | Multiplayer';
    history.replaceState(null, '', location.pathname);
    online(socket?.connected ? 'Conectado ao servidor' : 'Servidor desconectado', socket?.connected ? 'ok' : 'bad');
    showError('start-error', message || '');
  }
  function roomControl(event, payload = {}) {
    send(event, payload, error => {
      if (error) { $('feedback').textContent = error; window.alert(error); }
      else if (event === 'leaveRoom') backToStart('Você saiu da sala.');
    });
  }

  function send(event, data, onResult) {
    if (!socket?.connected) {
      const message = 'Sem conexão com o servidor. Aguarde a reconexão.';
      onResult?.(message, null);
      return;
    }
    socket.timeout(12000).emit(event, data, (err, response) => {
      if (err) return onResult?.('O servidor não respondeu. Tente novamente.', null);
      if (!response?.ok) return onResult?.(response?.message || 'Não foi possível concluir a operação.', null);
      onResult?.(null, response);
    });
  }
  function joinSaved() {
    if (!session || !socket?.connected) return;
    online('Reconectando à sala...');
    send('joinRoom', { code: session.code, name: session.name, token: session.token }, (error, welcome) => {
      if (error) {
        connecting = false; ready = false; reconnecting = false;
        online('Sala indisponível', 'bad');
        showError('start-error', `${error} Crie uma nova sala se a anterior não existir mais.`);
        $('room-view').hidden = true;
        $('start-view').hidden = false;
        clearSaved();
        return;
      }
      saveSession(welcome);
    });
  }
  function createRoom(name) {
    if (connecting) return;
    connecting = true;
    online('Criando sala...');
    send('createRoom', { name }, (error, welcome) => {
      connecting = false;
      if (error) { online('Não conectou', 'bad'); showError('start-error', error); return; }
      saveSession(welcome);
    });
  }
  function joinRoom(name, code) {
    if (connecting) return;
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length !== 7) return showError('start-error', 'O código da sala precisa ter 7 letras ou números.');
    connecting = true;
    online('Entrando na sala...');
    const old = getSaved();
    const token = old?.code === normalized ? old.token : undefined;
    send('joinRoom', { name, code: normalized, token }, (error, welcome) => {
      connecting = false;
      if (error) { online('Falha ao entrar', 'bad'); showError('start-error', error); return; }
      saveSession(welcome);
    });
  }
  function action(type, data = {}, onResult = null) {
    if (!ready) return;
    send('action', { action: type, ...data }, (err) => {
      if (err) { $('feedback').textContent = err; if (type === 'start') showError('host-error', err); }
      else { $('feedback').textContent = ''; if (type === 'start') showError('host-error', ''); }
      onResult?.(!err);
    });
  }
  function playerMarkup(p, lobby = false) {
    const active = p.id === state.players[state.turnIndex]?.id;
    const label = p.id === myPlayerId ? 'Você' : !p.connected ? 'Ausente' : p.id === state.hostId ? 'Anfitrião' : 'Online';
    const remove = isHost && p.id !== myPlayerId ? `<button type="button" class="btn danger small kick" data-kick="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Remover ${escapeHtml(p.name)} da sala">Remover</button>` : '';
    return `<div class="${lobby ? 'person-row' : 'score' + (active ? ' active' : '')}"><span class="avatar">${escapeHtml(p.name.charAt(0).toUpperCase())}</span><span class="${lobby ? 'pname' : 'name'}">${escapeHtml(p.name)}</span>${lobby ? `<span class="pill ${p.id === myPlayerId ? 'me' : !p.connected ? 'away' : ''}">${label}</span>${remove}` : `<span class="points">${p.score} ${p.score === 1 ? 'ponto' : 'pontos'}</span>${remove}`}</div>`;
  }
  function render() {
    if (!state) return;
    isHost = state.hostId === myPlayerId;
    $('role-label').textContent = isHost ? 'Anfitrião' : 'Participante';
    $('close-room').hidden = !isHost;
    $('lobby-view').hidden = state.phase !== 'lobby';
    $('game-view').hidden = state.phase === 'lobby';
    $('host-settings').hidden = !isHost;
    $('guest-wait').hidden = isHost;
    $('lobby-players').innerHTML = state.players.map(p => playerMarkup(p, true)).join('');
    if (state.phase === 'lobby') return;
    const picker = state.players[state.turnIndex];
    const guessing = state.phase === 'guess';
    const idx = state.guessIndex;
    const currentId = state.guessOrder[idx];
    const iCanPick = ready && state.phase === 'pick' && picker?.id === myPlayerId;
    const iCanGuess = ready && guessing && currentId === myPlayerId;
    $('round-label').textContent = `Rodada ${state.round}`;
    const revealed = Object.keys(state.revealed || {}).length;
    $('reveal-count').textContent = `${revealed} / ${state.wordCount} reveladas`;
    $('reveal-progress').style.width = `${state.wordCount ? 100 * revealed / state.wordCount : 0}%`;
    $('word-grid').innerHTML = Array.from({ length: state.wordCount }, (_, i) => {
      const shown = Object.hasOwn(state.revealed || {}, String(i));
      return `<button class="word ${shown ? 'revealed' : ''}" data-word="${i}" ${!iCanPick || shown ? 'disabled' : ''}><span class="num">Nº ${i + 1}</span><span class="${shown ? 'val' : 'lock'}">${shown ? escapeHtml(state.revealed[i]) : '••••'}</span></button>`;
    }).join('');
    $('turnbar').hidden = state.phase === 'ended';
    $('picker-name').textContent = picker?.name || '—';
    $('skip-pick').hidden = !iCanPick || state.players.filter(p => p.connected).length < 2;
    $('board-caption').textContent = state.phase === 'pick' ? (iCanPick ? 'É sua vez! Escolha um número para revelar a palavra.' : `Aguardando ${picker?.name || 'outro participante'} escolher um número...`) : guessing ? 'Agora todos tentam responder em ordem.' : 'A pergunta foi revelada!';
    $('guess-panel').hidden = state.phase === 'ended';
    $('guess-banner').hidden = !guessing;
    $('guess-caption').textContent = guessing ? (iCanGuess ? 'Agora é a sua tentativa!' : 'Aguarde sua vez de tentar adivinhar.') : 'Uma palavra precisa ser revelada primeiro.';
    $('guess-count').textContent = `Palpite ${idx + 1} de ${state.guessOrder.length}`;
    $('guesser-name').textContent = guessing ? state.players.find(p => p.id === currentId)?.name || '—' : '—';
    $('guess-order').textContent = guessing ? state.guessOrder.map(id => state.players.find(p => p.id === id)?.name || '—').join(' → ') : '';
    $('guess-input').disabled = !iCanGuess;
    $('guess-submit').disabled = !iCanGuess;
    $('guess-skip').disabled = !iCanGuess;
    if (!iCanGuess) $('guess-input').value = '';
    $('scoreboard').innerHTML = state.players.map(p => playerMarkup(p)).join('');
    $('event-log').innerHTML = (state.events || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
    $('round-result').hidden = state.phase !== 'ended';
    if (state.phase === 'ended') {
      const result = state.result || {};
      $('result-eyebrow').textContent = result.winnerId ? 'Resposta correta' : 'Fim da rodada';
      $('result-title').textContent = result.winnerId ? `${result.winnerName || state.players.find(p => p.id === result.winnerId)?.name || 'Alguém'} ganhou 1 ponto!` : 'Ninguém acertou desta vez.';
      $('question-result').textContent = result.question || '';
      $('answer-result').textContent = result.answer || '';
      $('next-round').hidden = !isHost;
      $('waiting-next').hidden = isHost;
    }
  }
  function copy(text, element, successMessage) {
    navigator.clipboard?.writeText(text).then(() => {
      element.textContent = successMessage;
      setTimeout(() => { element.textContent = element.dataset.original; }, 1800);
    }).catch(() => { window.prompt('Copie o texto:', text); });
    if (!navigator.clipboard) window.prompt('Copie o texto:', text);
  }
  function bind() {
    $('create-form').addEventListener('submit', e => {
      e.preventDefault(); showError('start-error', '');
      const name = short($('create-name').value);
      if (name) createRoom(name);
    });
    $('join-form').addEventListener('submit', e => {
      e.preventDefault(); showError('start-error', '');
      const name = short($('join-name').value);
      if (name) joinRoom(name, $('join-code').value);
    });
    document.querySelectorAll('input[name="question-mode"]').forEach(x => x.addEventListener('change', () => {
      $('custom-fields').hidden = document.querySelector('input[name="question-mode"]:checked').value !== 'custom';
    }));
    $('start-game').addEventListener('click', () => {
      const mode = document.querySelector('input[name="question-mode"]:checked')?.value || 'surprise';
      action('start', { mode, question: $('custom-question').value.trim(), answer: $('custom-answer').value.trim() });
    });
    $('word-grid').addEventListener('click', e => {
      const button = e.target.closest('[data-word]');
      if (button && !button.disabled) action('reveal', { index: Number(button.dataset.word) });
    });
    $('skip-pick').addEventListener('click', () => action('skipPick'));
    $('guess-form').addEventListener('submit', e => {
      e.preventDefault(); const guess = $('guess-input').value.trim();
      if (!guess) return;
      action('guess', { guess }, sent => { if (sent) $('guess-input').value = ''; });
    });
    $('guess-skip').addEventListener('click', () => action('skipGuess'));
    $('next-round').addEventListener('click', () => {
      action('nextRound', {}, sent => { if (sent) { $('custom-question').value = ''; $('custom-answer').value = ''; } });
    });
    $('copy-code').dataset.original = $('copy-code').textContent;
    $('copy-link').dataset.original = $('copy-link').textContent;
    $('copy-code').addEventListener('click', () => copy(roomCode, $('copy-code'), 'Código copiado!'));
    $('copy-link').addEventListener('click', () => copy(invitation(), $('copy-link'), 'Link copiado!'));
    $('leave-room').addEventListener('click', () => {
      const others = state?.players.filter(p => p.id !== myPlayerId).length || 0;
      const message = isHost && others ? 'Sair desta sala? Outro participante assumirá como anfitrião.' :
        isHost ? 'Sair da sala? Como você é a única pessoa, a sala será fechada.' : 'Deseja sair desta sala?';
      if (window.confirm(message)) roomControl('leaveRoom');
    });
    $('close-room').addEventListener('click', () => {
      if (window.confirm('Encerrar esta sala para todos os participantes? A partida será apagada e o código deixará de funcionar.')) roomControl('closeRoom');
    });
    function handleRemoveClick(e) {
      const target = e.target.closest('[data-kick]');
      if (!target || !isHost) return;
      if (window.confirm(`Remover ${target.dataset.name} da sala? O participante perderá o acesso a esta partida.`)) {
        roomControl('kickPlayer', { playerId: target.dataset.kick });
      }
    }
    $('lobby-players').addEventListener('click', handleRemoveClick);
    $('scoreboard').addEventListener('click', handleRemoveClick);
    window.addEventListener('beforeunload', e => {
      if (isHost && ready && state?.phase === 'guess') { e.preventDefault(); e.returnValue = ''; }
    });
  }
  function initConnection() {
    if (location.protocol === 'file:') {
      online('Servidor necessário', 'bad');
      showError('start-error', 'Esta versão precisa rodar no servidor Node. Execute npm start ou publique como Web Service no Render.');
      return;
    }
    if (typeof io !== 'function') {
      online('Servidor indisponível', 'bad');
      showError('start-error', 'Não foi possível carregar o sistema multiplayer. Confira se o servidor está online.');
      return;
    }
    socket = io({ transports: ['polling', 'websocket'], reconnection: true, reconnectionDelay: 700, reconnectionDelayMax: 4000, timeout: 15000 });
    socket.on('connect', () => {
      if (session) joinSaved();
      else online('Conectado ao servidor', 'ok');
    });
    socket.on('roomState', next => {
      if (!ready) return;
      state = next;
      render();
    });
    socket.on('disconnect', () => {
      if (ready) {
        ready = false; reconnecting = true;
        online('Reconectando...', 'bad');
        $('connection-warning').hidden = false;
        $('connection-warning').textContent = 'A conexão caiu. Tentando entrar novamente na mesma sala...';
        render();
      } else online('Servidor desconectado', 'bad');
    });
    socket.on('connect_error', () => {
      online('Servidor indisponível', 'bad');
      if (!ready && !reconnecting) showError('start-error', 'Não foi possível conectar ao servidor. Se estiver no Render gratuito, ele pode estar iniciando. Tente novamente daqui a pouco.');
    });
    socket.on('removedFromRoom', payload => {
      if (payload?.code && payload.code !== roomCode) return;
      backToStart(payload?.message || 'Você foi removido da sala pelo anfitrião.');
    });
    socket.on('roomClosed', payload => {
      if (payload?.code && payload.code !== roomCode) return;
      backToStart(payload?.message || 'A sala foi encerrada.');
    });
    socket.on('sessionReplaced', () => {
      ready = false;
      clearSaved();
      $('connection-warning').hidden = false;
      $('connection-warning').textContent = 'Sua sessão foi aberta em outra aba. Use essa outra aba para jogar.';
      online('Sessão em outra aba', 'bad');
    });
  }

  bind();
  if (urlCode) { $('join-code').value = urlCode; $('join-name').focus(); }
  const previous = getSaved();
  if (previous && (!urlCode || previous.code === urlCode)) {
    session = previous;
    $('join-name').value = previous.name;
    $('join-code').value = previous.code;
    online('Retomando sua sala...');
  }
  initConnection();
})();

# Pergunta Secreta — Multiplayer com servidor

A versão anterior dependia de conexão direta entre computadores via PeerJS. Agora, as salas e as regras do jogo são controladas por um **servidor Node.js com Socket.IO**. A conexão tenta HTTP long-polling e WebSocket, aumentando a compatibilidade com redes diferentes. A pergunta e a resposta permanecem no servidor até o final da rodada.

## Executar no computador

Necessário Node.js 20 ou superior.

```bash
npm install
npm start
```

Abra http://localhost:3000 e crie uma sala. Para um teste local, abra outra janela anônima ou outro navegador e entre com o código.

**Atenção:** `localhost` só serve para testes na sua máquina. Para jogar com amigos em outros computadores, publique este projeto como serviço Web Node.js. Abrir o `public/index.html` diretamente ou enviar apenas o HTML ao Netlify Drop **não funciona**.

## Publicar para usar com amigos (Render)

1. Extraia o ZIP e envie os arquivos e pastas **como repositório** para o GitHub, mantendo `server.js`, `package.json` e a pasta `public` na raiz.
2. Entre no https://dashboard.render.com e escolha **New > Web Service**.
3. Conecte o repositório e selecione o plano **Free**, caso esteja disponível.
4. Configure **Build Command** como `npm install --omit=dev` e **Start Command** como `npm start`.
5. Quando o serviço ficar como **Live**, abra o link `https://...onrender.com` fornecido pelo Render.
6. Crie uma sala e compartilhe o link de convite exibido no jogo. Todos acessam o **mesmo site**.

O arquivo `render.yaml` pode ser usado como Blueprint, se preferir.

## Limitações importantes

- O serviço gratuito do Render pode entrar em repouso após 15 minutos sem tráfego. Ele reinicia com novo acesso; porém salas em memória se perdem quando o processo reinicia.
- A partida e o placar ficam na **memória do servidor**; não há persistência em banco de dados. Redeploys e reinicializações perdem as salas.
- Redes corporativas muito restritivas ainda podem bloquear a conexão ao serviço. O Socket.IO tenta HTTP long-polling como alternativa a WebSocket.
- Até 12 participantes por sala.
- O anfitrião não precisa manter a aba aberta durante o jogo: se ele cair, o servidor pode transferir essa função após alguns segundos para outro participante conectado.

## Regras

1. Alguém cria a sala e compartilha o link. Cada um entra com seu nome.
2. Quem está na vez escolhe um número; uma palavra da pergunta é revelada **para todos**.
3. Os palpites seguem automaticamente a ordem circular, começando por quem pediu a dica.
4. Cada pessoa pode tentar uma vez por palavra revelada. Se ninguém acertar, o próximo participante pede outra palavra.
5. Quem acerta ganha um ponto; o anfitrião inicia a rodada seguinte.
6. Com um só jogador, ele pode pedir novas palavras após errar ou pular a tentativa.
7. É possível usar perguntas surpresa ou cadastrar pergunta própria.

## Estrutura

- `server.js`: regras, salas e validação das jogadas
- `public/index.html`: interface do jogo
- `public/app.js`: comunicação com o servidor e controles
- `render.yaml`: configuração para o Render
- `tests/game.test.js`: testes automatizados (`npm test`, depois de `npm install`)

## Privacidade

Cada participante informa apenas um nome de exibição. A sessão é identificada por token aleatório salvo na aba do navegador. As respostas secretas não são transmitidas aos participantes antes da rodada acabar.

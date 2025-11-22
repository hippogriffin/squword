const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
// Allow DB file path to be overridden via environment variable so container
// users can mount a volume (e.g. /data) for persistence. Default remains
// 'squword-db.json' in the working directory for backward compatibility.
const DB_PATH = process.env.squword_DB || 'squword-db.json';
const db = new Low(new JSONFile(DB_PATH), { games: {} });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Disable the X-Powered-By header to avoid revealing Express usage
app.disable('x-powered-by');

// Security headers middleware - follows OWASP Secure Headers best practices
app.use((req, res, next) => {
  // HSTS: only send when connection is known to be secure
  const isSecure = req.secure || (req.headers['x-forwarded-proto'] === 'https');
  if (isSecure) {
    // 2 years, include subdomains, allow preload
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  // Prevent MIME-type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions policy (disable powerful features by default)
  res.setHeader('Permissions-Policy', "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  // IE/Edge download option
  res.setHeader('X-Download-Options', 'noopen');
  // Cross-origin resource policy
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Cross-origin opener policy
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // Content Security Policy - reasonably strict for this app
  // - allow same-origin for everything
  // - allow inline styles/scripts where necessary (keeps compatibility with simple apps)
  // - allow data: for images
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);

  next();
});

const BOARD_SIZE = 15;
const MAX_ROUNDS = 12;
// Simple in-memory cache for word definitions to avoid repeated external calls
// Cache entries have a TTL so definitions refresh periodically.
const DEF_CACHE_TTL_MS = Number(process.env.DEF_CACHE_TTL_MS) || (24 * 60 * 60 * 1000); // 24h default
const definitionCache = new Map(); // word -> { defs: [...], ts: Date.now() }
const LETTER_POINTS = {
  'A': 1, 'B': 3, 'C': 3, 'D': 2, 'E': 1, 'F': 4, 'G': 2, 'H': 4, 'I': 1,
  'J': 8, 'K': 5, 'L': 1, 'M': 3, 'N': 1, 'O': 1, 'P': 3, 'Q': 10, 'R': 1, 'S': 1,
  'T': 1, 'U': 1, 'V': 4, 'W': 4, 'X': 8, 'Y': 4, 'Z': 10
};
const BONUS_BOARD = [
  ["TW","","","","TL","","","","TW","","","","TL","","","TW"],
  ["","DW","","","","","","DL","","DL","","","","DW",""],
  ["","","DW","","","TL","","","","TL","","","DW","",""],
  ["","","","DW","","","DL","","DL","","","DW","","",""],
  ["TL","","","","DW","","","","DW","","","","","TL"],
  ["","","TL","","","TL","","","","TL","","","TL","",""],
  ["","","","DL","","","DL","","DL","","","DL","","",""],
  ["TW","","","","DW","","CENTER","","DW","","","","TW",""],
  ["","","","DL","","","DL","","DL","","","DL","","",""],
  ["","","TL","","","TL","","","","TL","","","TL","",""],
  ["TL","","","","DW","","","","DW","","","","","TL"],
  ["","","","DW","","","DL","","DL","","","DW","","",""],
  ["","","DW","","","TL","","","","TL","","","DW","",""],
  ["","DW","","","","","","DL","","DL","","","","DW",""],
  ["TW","","","","TL","","","","TW","","","","TL","","","TW"]
];

function generateJoinCode(length = 8) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // avoid ambiguous chars
  let code = '';
  for (let i = 0; i < length; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getInitialRack(tileBag, count = 7) {
  const rack = [];
  for (let i = 0; i < count && tileBag.length > 0; i++) {
    const idx = Math.floor(Math.random() * tileBag.length);
    rack.push(tileBag.splice(idx, 1)[0]);
  }
  return rack;
}

function saveGameRoom(room, game) {
  db.data.games[room] = game;
  db.write();
}

function loadGameRoom(room) {
  return db.data.games[room];
}

const games = {};

function ensurePlayerRack(game, playerIdx) {
  if (!game || !game.players || typeof game.players[playerIdx] === 'undefined') return;
  const player = game.players[playerIdx];
  player.rack = player.rack || [];
  // Ensure exactly 7 slots (0..6), fill undefined with null
  for (let i = 0; i < 7; i++) if (typeof player.rack[i] === 'undefined') player.rack[i] = null;
  // Draw tiles to fill empty slots from game's tileBag
  const emptySlots = player.rack.filter(x => !x).length;
  if (emptySlots > 0 && game.tileBag && game.tileBag.length > 0) {
    const newTiles = getInitialRack(game.tileBag, emptySlots);
    let nt = 0;
    for (let i = 0; i < 7 && nt < newTiles.length; i++) {
      if (!player.rack[i]) { player.rack[i] = newTiles[nt++]; }
    }
  }
}

io.on("connection", (socket) => {
  socket.on("join", async ({room, name, persistentId, boardSize, rounds, joinCode}) => {
    await db.read();
    db.data ||= { games: {} };

  let game = loadGameRoom(room);
    if (!game) {
      const squword_TILE_COUNTS = {
            A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1,
            K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6,
            U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1
        };
    function buildTileBag() {
    const bag = [];
    for (const [letter, count] of Object.entries(squword_TILE_COUNTS)) {
        for (let i = 0; i < count; i++) {
        bag.push(letter);
        }
    }
    return bag;
    }

    // In your game init: allow the first player to request a board size and rounds
    const tileBag = buildTileBag();
      // sanitize board size and rounds provided by the creator
      let size = BOARD_SIZE;
      if (typeof boardSize !== 'undefined') {
        const n = Number(boardSize);
        if (Number.isInteger(n) && n >= 5 && n <= 25) size = n;
      }
      let maxRounds = MAX_ROUNDS;
      if (typeof rounds !== 'undefined') {
        const r = Number(rounds);
        if (Number.isInteger(r) && r >= 1 && r <= 1000) maxRounds = r;
      }
      // generate a join code for the new room and give it to the creator
      const code = generateJoinCode();
      game = {
        board: Array.from({length:size},()=>Array(size).fill("")),
        players: [],
        turnIdx: 0,
        tileBag,
        running: false,
        boardSize: size,
        rounds: 0,
        maxRounds,
        joinCode: code
      };
    } else {
      // If the room already exists, require a matching joinCode
      if (game.joinCode && joinCode !== game.joinCode) {
        socket.emit('join_denied', { msg: 'Invalid join code' });
        return;
      }
      // If a game already exists, ignore any boardSize/rounds provided by
      // this joining socket (only the initial creator may set them).
      if (typeof boardSize !== 'undefined' || typeof rounds !== 'undefined') {
        console.debug('Join: non-creator attempted to set boardSize/rounds - ignored', { room, socketId: socket.id, boardSize, rounds });
      }
    }
    let existingPlayer = persistentId ?
      (game.players || []).find(p => p.persistentId && p.persistentId === persistentId)
      : null;
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      socket.join(room);
      const idx = game.players.indexOf(existingPlayer);
      ensurePlayerRack(game, idx);
      socket.emit("join_ok", {id: socket.id, rackIdx: idx});
      games[room] = game; saveGameRoom(room, game);
      broadcastGame(room);
      return;
    }
    if ((game.players||[]).length >= 4) {
      socket.emit("join_ok", {id: socket.id, rackIdx: -1});
      return;
    }
  const rack = getInitialRack(game.tileBag, 7);
    const rackIdx = (game.players||[]).length;
    game.players = game.players || [];
    game.players.push({
      id: socket.id,
      persistentId,
      name,
      rack,
      score: 0
    });
    // ensure newly added player's rack is filled to 7 if possible
    ensurePlayerRack(game, rackIdx);
    socket.join(room);
  socket.emit("join_ok", {id: socket.id, rackIdx, joinCode: game.joinCode});
    game.running = game.players.length >= 2;
    // initialize round tracking when the game first becomes active
    if (game.running && typeof game.roundStart === 'undefined') {
      game.roundStart = game.turnIdx || 0;
      game.rounds = game.rounds || 0;
      game.maxRounds = game.maxRounds || MAX_ROUNDS;
    }
    games[room] = game; saveGameRoom(room, game);
    broadcastGame(room);
  });

  socket.on("play_tiles", async ({placements, room}) => {
    await db.read();
    db.data ||= { games: {} };

    let game = loadGameRoom(room);
    if (!game || !game.running) { socket.emit("move_result", {ok:false,msg:"Game not started"}); return; }
    const playerIdx = game.players.findIndex(p=>p.id===socket.id);
    if (playerIdx !== game.turnIdx) { socket.emit("move_result", {ok:false,msg:"Not your turn"}); return; }
    if (!Array.isArray(placements) || placements.length === 0) { socket.emit("move_result",{ok:false,msg:"No tiles placed"}); return;}

    // Coerce incoming placement coordinates to integers to avoid string/number
    // mismatches (e.g. '0' vs 0) which can break equality checks at the board
    // edges. Also validate that they are integers.
    // Coerce and normalize placements to numeric row/col values
    for (let i = 0; i < placements.length; i++) {
      placements[i].row = Number(placements[i].row);
      placements[i].col = Number(placements[i].col);
    }
  // build straightforward numeric coords array matching placements order
  const coords = placements.map(p => [p.row, p.col]);
    // Fallback safe recompute in case placements don't have index property
    // (the above line attempts to use placement.index if present). Ensure coords are integers.
    for (let i = 0; i < placements.length; i++) {
      const r = placements[i].row;
      const c = placements[i].col;
      if (!Number.isInteger(r) || !Number.isInteger(c)) {
        socket.emit("move_result", {ok:false, msg: "Invalid placement coordinates"});
        return;
      }
      // overwrite coords explicitly with normalized numbers
      // (keeps order consistent with placements)
      // we'll build a fresh coords array next to avoid any surprises.
    }
    // build fresh numeric coords array
    const numericCoords = placements.map(p => [p.row, p.col]);
    // Reject placements outside the fixed board bounds
    const maxRowIdx = game.board.length - 1;
    const maxColIdx = game.board[0].length - 1;
    if (numericCoords.some(([r,c]) => r < 0 || c < 0 || r > maxRowIdx || c > maxColIdx)) {
      console.debug('Placement out of bounds', {numericCoords, maxRowIdx, maxColIdx});
      socket.emit("move_result", {ok:false, msg: "Placement out of board bounds"});
      return;
    }
    const allSameRow = numericCoords.every(([r,_]) => r === numericCoords[0][0]);
    const allSameCol = numericCoords.every(([_,c]) => c === numericCoords[0][1]);
    if (!(allSameRow || allSameCol)) {
      console.debug('Invalid straight-line placement', {numericCoords, placements});
      socket.emit("move_result",{ok:false,msg:"Tiles must be in straight line"}); return;
    }
    const sorted = (allSameRow ? numericCoords.map(([_,c])=>c) : numericCoords.map(([r,_])=>r)).slice().sort((a,b)=>a-b);
    for (let i=sorted[0]; i<=sorted[sorted.length-1]; i++){
      let r = allSameRow ? numericCoords[0][0] : i;
      let c = allSameRow ? i : numericCoords[0][1];
      const placementExists = placements.some(p=>p.row===r && p.col===c);
      const boardRowExists = game.board[r] !== undefined;
      const boardCell = boardRowExists ? game.board[r][c] : undefined;
      if (!placementExists && !boardCell) {
        console.debug('Contiguity check failed', {r, c, placementExists, boardRowExists, boardCell, numericCoords, sorted});
        socket.emit("move_result",{ok:false,msg:"Tiles must be contiguous"}); return;
      }
    }

    // If this is the first move (board currently empty), require that the
    // placements include the center square.
    const boardHasTiles = game.board.some(row => row.some(cell => cell));
    if (!boardHasTiles) {
      const center = Math.floor(game.board.length / 2);
      const touchesCenter = placements.some(p => p.row === center && p.col === center);
      if (!touchesCenter) {
        socket.emit('move_result', { ok: false, msg: 'First move must cover the center square' });
        return;
      }
    }

    async function validateAllWords() {
      const mainWord = getFullWord(game.board, placements);
      let wordsToCheck = mainWord ? [mainWord] : [];
      for (const cw of getCrossWords(game.board, placements)) {
        if (cw.word.length > 1) wordsToCheck.push(cw.word);
      }
      const definitions = {};
      for (const word of wordsToCheck) {
        const defs = await isValidWordAPI(word);
        if (!defs) {
          socket.emit("move_result",{ok:false,msg:`'${word}' not valid!`}); return false;
        }
        definitions[word] = defs;
      }
      // Store last validated words' definitions on the game so clients can display them
      game.lastDefinitions = definitions;
      return true;
    }

    validateAllWords().then(async (valid)=>{
      if (!valid) return;

      const scoreObj = calculateWordScore(game.board, placements);
      console.debug('Computed score for placement', { placements, scoreObj });
      game.players[playerIdx].score += scoreObj.total;

      for (const {row,col,letter,rackIdx} of placements) {
        game.board[row][col] = letter;
        // Mark the used rack slot as empty if valid
        if (typeof rackIdx === 'number' && rackIdx >= 0 && rackIdx < 7) {
          game.players[playerIdx].rack[rackIdx] = null;
        }
      }
      // Ensure rack array exists and has length 8 with nulls for empty slots
  const playerRack = game.players[playerIdx].rack = game.players[playerIdx].rack || [];
  for (let i = 0; i < 7; i++) if (typeof playerRack[i] === 'undefined') playerRack[i] = null;
      // Count empty slots and draw exactly that many tiles, filling null slots in order
      const emptySlots = playerRack.filter(x => !x).length;
      const newTiles = getInitialRack(game.tileBag, emptySlots);
      let nt = 0;
      for (let i = 0; i < 7 && nt < newTiles.length; i++) {
        if (!playerRack[i]) { playerRack[i] = newTiles[nt++]; }
      }

      // If we couldn't fully refill the player's rack, enter final phase
      if (newTiles.length < emptySlots) {
        game.finalPhase = true;
        game.finalStarter = playerIdx;
        game.finalRemaining = Math.max(0, (game.players || []).length - 1);
        console.debug('Entering final phase', { finalStarter: game.finalStarter, finalRemaining: game.finalRemaining, playerCount: game.players.length });
      }

      // Advance turn or handle final-phase countdown
      if (game.finalPhase) {
        // If the player who just moved is NOT the starter, consume one of the final turns
        if (playerIdx !== game.finalStarter) {
          game.finalRemaining = Math.max(0, (game.finalRemaining || 0) - 1);
          console.debug('Final remaining decremented', { finalRemaining: game.finalRemaining, by: playerIdx });
        }
        // If we've consumed all final turns, end the game now (do not advance to starter again)
        if (game.finalRemaining <= 0) {
          games[room] = game; saveGameRoom(room, game);
          endGame(room);
          socket.emit("move_result",{ok:true});
          return;
        }
      }

      // Normal turn advance
      const prevTurn = game.turnIdx;
      game.turnIdx = (game.turnIdx + 1) % game.players.length;
      // If we've returned to the start of a round, increment rounds
      if (game.turnIdx === game.roundStart) {
        game.rounds = (game.rounds || 0) + 1;
        console.debug('Round advanced', { rounds: game.rounds });
      }
      // End if we reached max rounds
      if (game.rounds >= (game.maxRounds || MAX_ROUNDS)) {
        games[room] = game; saveGameRoom(room, game);
        endGame(room);
        socket.emit("move_result",{ok:true});
        return;
      }
      games[room] = game; saveGameRoom(room, game);
      broadcastGame(room);
      socket.emit("move_result",{ok:true});
    });
  });

  socket.on("skip_turn", async ({ room }) => {
    await db.read();
    db.data ||= { games: {} };

    let game = loadGameRoom(room);
    if (!game || !game.running) return;
    const playerIdx = game.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== game.turnIdx) return;

    const player = game.players[playerIdx];
    // Ensure rack has length 7
    player.rack = player.rack || [];
    for (let i = 0; i < 7; i++) if (typeof player.rack[i] === 'undefined') player.rack[i] = null;
    const drawCnt = player.rack.filter(ltr => !ltr).length;
    if (drawCnt > 0) {
      const newTiles = getInitialRack(game.tileBag, drawCnt);
      let nt = 0;
      for (let i = 0; i < 7 && nt < newTiles.length; i++) {
        if (!player.rack[i]) { player.rack[i] = newTiles[nt++]; }
      }
    }
    // Handle final-phase countdown if active
    if (game.finalPhase) {
      if (playerIdx !== game.finalStarter) {
        game.finalRemaining = Math.max(0, (game.finalRemaining || 0) - 1);
      }
      if (game.finalRemaining <= 0) {
        games[room] = game; saveGameRoom(room, game);
        endGame(room);
        return;
      }
    }
    const prevTurn = game.turnIdx;
    game.turnIdx = (game.turnIdx + 1) % game.players.length;
    if (game.turnIdx === game.roundStart) {
      game.rounds = (game.rounds || 0) + 1;
      console.debug('Round advanced (skip)', { rounds: game.rounds });
    }
    if (game.rounds >= (game.maxRounds || MAX_ROUNDS)) {
      games[room] = game; saveGameRoom(room, game);
      endGame(room);
      return;
    }
    games[room] = game; saveGameRoom(room, game);
    broadcastGame(room);
  });

  socket.on('reorder_rack', async ({ room, rack }) => {
    await db.read();
    db.data ||= { games: {} };
    let game = loadGameRoom(room);
    if (!game) return;
    const playerIdx = game.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;
    // sanitize incoming rack: must be an array of length 7 with letters or null
    if (!Array.isArray(rack)) return;
    const sanitized = Array.from({length:7}, (_,i) => (typeof rack[i] !== 'undefined' && rack[i] !== null) ? String(rack[i]) : null);
    // Validate that the multiset of letters (ignoring nulls) matches the server-known multiset for this player's current rack
    const serverRack = game.players[playerIdx].rack || [];
    const sList = serverRack.map(x => x).filter(x => x).slice().sort();
    const cList = sanitized.map(x => x).filter(x => x).slice().sort();
    if (sList.length !== cList.length) return; // mismatch
    for (let i = 0; i < sList.length; i++) if (sList[i] !== cList[i]) return; // mismatch

    // If valid, persist the new order
    game.players[playerIdx].rack = sanitized;
    games[room] = game; saveGameRoom(room, game);
    broadcastGame(room);
  });

  socket.on("disconnect", async () => {
    await db.read();
    db.data ||= { games: {} };

    for (const room of Object.keys(db.data.games)) {
      let game = loadGameRoom(room);
      const idx = game.players.findIndex(p=>p.id===socket.id);
      if (idx !== -1) {
        game.players.splice(idx, 1);
        if (game.players.length === 0) {
          delete db.data.games[room];
          await db.write();
        } else {
          if (game.turnIdx >= game.players.length) game.turnIdx = 0;
          games[room] = game; saveGameRoom(room, game);
          broadcastGame(room);
        }
        break;
      }
    }
  });
});

function getFullWord(board, placements) {
  const coords = placements.map(p => [p.row, p.col]);
  const allSameRow = coords.every(([r,_]) => r === coords[0][0]);
  const allSameCol = coords.every(([_,c]) => c === coords[0][1]);
  let word = '';
  const maxRow = board.length - 1;
  const maxCol = board[0].length - 1;
  if (allSameRow) {
    const row = coords[0][0];
    let minCol = Math.min(...coords.map(([_,c]) => c));
    let maxColUsed = Math.max(...coords.map(([_,c]) => c));
    while (minCol > 0 && board[row][minCol-1]) minCol--;
    while (maxColUsed < maxCol && board[row][maxColUsed+1]) maxColUsed++;
    for (let col = minCol; col <= maxColUsed; ++col){
      const placed = placements.find(p=>p.row===row && p.col===col);
      word += placed ? placed.letter : (board[row][col] || '');
    }
  } else if (allSameCol){
    const col = coords[0][1];
    let minRow = Math.min(...coords.map(([r,_]) => r));
    let maxRowUsed = Math.max(...coords.map(([r,_]) => r));
    while (minRow > 0 && board[minRow-1][col]) minRow--;
    while (maxRowUsed < maxRow && board[maxRowUsed+1][col]) maxRowUsed++;
    for (let row=minRow; row<=maxRowUsed; ++row){
      const placed = placements.find(p=>p.row===row && p.col===col);
      word += placed ? placed.letter : (board[row][col] || '');
    }
  }
  return word;
}

function endGame(room) {
  const game = games[room] || loadGameRoom(room);
  if (!game) return;
  // Compute final scores: simple highest-score winner. In real squword you'd subtract remaining tiles, but keep it simple here.
  let maxScore = -Infinity;
  let winners = [];
  for (let i = 0; i < (game.players || []).length; i++) {
    const p = game.players[i];
    if (p.score > maxScore) { maxScore = p.score; winners = [i]; }
    else if (p.score === maxScore) winners.push(i);
  }
  game.running = false;
  game.ended = true;
  game.winners = winners;
  games[room] = game; saveGameRoom(room, game);
  io.to(room).emit('game_update', { board: game.board, turnIdx: game.turnIdx, players: game.players, ended: true, winners });
  console.debug('Game ended', { room, winners, maxScore });
}

function getCrossWords(board, placements) {
  const crossWords = [];
  const coords = placements.map(p => [p.row, p.col]);
  const allSameRow = coords.every(([r,_]) => r === coords[0][0]);
  const allSameCol = coords.every(([_,c]) => c === coords[0][1]);
  const maxRow = board.length - 1;
  const maxCol = board[0].length - 1;
  for (const {row, col, letter} of placements) {
    let word = letter;
    let tiles = [{letter, isNew:true, row, col}];
    if (allSameRow) {
      let r = row - 1;
      while (r >= 0 && (board[r][col] || placements.find(p=>p.row===r&&p.col===col))) {
        const l = (placements.find(p=>p.row===r&&p.col===col)?.letter) || board[r][col];
        word = l + word;
        tiles.unshift({letter: l, isNew:false, row: r, col: col});
        r--;
      }
      r = row + 1;
      while (r <= maxRow && (board[r][col] || placements.find(p=>p.row===r&&p.col===col))) {
        const l = (placements.find(p=>p.row===r&&p.col===col)?.letter)||board[r][col];
        word = word + l;
        tiles.push({letter: l, isNew:false, row: r, col: col});
        r++;
      }
    } else if (allSameCol) {
      let c = col - 1;
      while (c >= 0 && (board[row][c] || placements.find(p=>p.row===row&&p.col===c))) {
        const l = (placements.find(p=>p.row===row&&p.col===c)?.letter)||board[row][c];
        word = l + word;
        tiles.unshift({letter: l, isNew:false, row: row, col: c});
        c--;
      }
      c = col + 1;
      while (c <= maxCol && (board[row][c] || placements.find(p=>p.row===row&&p.col===c))) {
        const l = (placements.find(p=>p.row===row&&p.col===c)?.letter)||board[row][c];
        word = word + l;
        tiles.push({letter: l, isNew:false, row: row, col: c});
        c++;
      }
    }
    if (word.length > 1) {
      crossWords.push({word, tiles});
    }
  }
  return crossWords;
}

function calculateWordScore(board, placements) {
  try {
    console.debug('calculateWordScore called', {
      boardRows: board ? board.length : 0,
      boardCols: board && board[0] ? board[0].length : 0,
      placements
    });
  } catch (e) { /* ignore logging errors */ }
  function scoreOneWord(wordTiles) {
    let score = 0, wordMultipliers = [];
    for (const {letter, isNew, row, col} of wordTiles) {
      if (!letter) continue;
      let tileScore = LETTER_POINTS[letter.toUpperCase()] || 0;
      const bonus = (BONUS_BOARD[row] && BONUS_BOARD[row][col]) ? BONUS_BOARD[row][col] : '';
      if (isNew) {
        if (bonus === "DL") tileScore *= 2;
        if (bonus === "TL") tileScore *= 3;
        if (bonus === "DW") wordMultipliers.push(2);
        if (bonus === "TW") wordMultipliers.push(3);
        if (bonus === "CENTER") wordMultipliers.push(2);
      }
      score += tileScore;
    }
    let wordTotalMult = wordMultipliers.reduce((prod, val) => prod * val, 1);
    score *= wordTotalMult || 1;
    return score;
  }
  const coords = placements.map(p => [p.row, p.col]);
  const allSameRow = coords.every(([r,_]) => r === coords[0][0]);
  const allSameCol = coords.every(([_,c]) => c === coords[0][1]);
  let mainWordTiles = [];
  if (allSameRow) {
    const row = coords[0][0];
    let minCol = Math.min(...coords.map(([_,c]) => c));
    let maxCol = Math.max(...coords.map(([_,c]) => c));
    const maxColIdx = board[0].length - 1;
    while (minCol > 0 && board[row][minCol-1]) minCol--;
    while (maxCol < maxColIdx && board[row][maxCol+1]) maxCol++;
    for (let col = minCol; col <= maxCol; ++col) {
      let letter = null, isNew = false;
      const pending = placements.find(p => p.row === row && p.col === col);
      if (pending) { letter = pending.letter; isNew = true; }
      else if (board[row][col]) { letter = board[row][col]; isNew = false; }
      else { letter = null; }
      mainWordTiles.push({letter, isNew, row, col});
    }
  } else if (allSameCol) {
    const col = coords[0][1];
    let minRow = Math.min(...coords.map(([r,_]) => r));
    let maxRow = Math.max(...coords.map(([r,_]) => r));
    const maxRowIdx = board.length - 1;
    while (minRow > 0 && board[minRow-1][col]) minRow--;
    while (maxRow < maxRowIdx && board[maxRow+1][col]) maxRow++;
    for (let row = minRow; row <= maxRow; ++row) {
      let letter = null, isNew = false;
      const pending = placements.find(p => p.row === row && p.col === col);
      if (pending) { letter = pending.letter; isNew = true; }
      else if (board[row][col]) { letter = board[row][col]; isNew = false; }
      else { letter = null; }
      mainWordTiles.push({letter, isNew, row, col});
    }
  }
  console.debug('mainWordTiles', { mainWordTiles });
  let mainScore = scoreOneWord(mainWordTiles);
  let crossScores = 0;
  const crossWords = getCrossWords(board, placements);
  console.debug('crossWords', { crossWords });
  for (const {word, tiles} of crossWords) {
    if ((allSameRow && tiles.every(t=>t.row===coords[0][0])) ||
        (allSameCol && tiles.every(t=>t.col===coords[0][1]))) continue;
    console.debug('scoring cross word', { word, tiles });
    crossScores += scoreOneWord(tiles);
  }
  console.debug('calculateWordScore result', { mainScore, crossScores, total: mainScore + crossScores });
  return {mainScore, crossScores, total: mainScore + crossScores};
}

async function isValidWordAPI(word) {
  const key = String(word).toLowerCase();
  const now = Date.now();
  const cached = definitionCache.get(key);
  if (cached && (now - cached.ts) < DEF_CACHE_TTL_MS) {
    return cached.defs;
  }
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`);
    if (!response.ok) {
      definitionCache.set(key, { defs: null, ts: now });
      return null;
    }
    const data = await response.json();
    // Extract simple definitions: an array of short definition strings
    const defs = [];
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry.meanings && Array.isArray(entry.meanings)) {
          for (const meaning of entry.meanings) {
            if (meaning.definitions && Array.isArray(meaning.definitions)) {
              for (const d of meaning.definitions) {
                if (d.definition) defs.push(d.definition);
              }
            }
          }
        }
      }
    }
    const out = defs.length ? defs : null;
    definitionCache.set(key, { defs: out, ts: now });
    return out;
  } catch (err) {
    // Cache negative result for a short time to avoid repeated failures
    definitionCache.set(key, { defs: null, ts: now });
    return null;
  }
}

function broadcastGame(room) {
  const game = games[room] || loadGameRoom(room);
  if (!game) return;
  io.to(room).emit("game_update", {
    board: game.board,
    turnIdx: game.turnIdx,
    // Ensure clients always receive a rack array of length 7 (use null for empty slots)
    players: game.players.map(p => ({
      name: p.name,
      rack: Array.from({length:7}, (_,i) => (p.rack && typeof p.rack[i] !== 'undefined') ? p.rack[i] : null),
      score: p.score
    })),
    joinCode: game.joinCode || null,
    // lastDefinitions contains word -> [definitions] populated when server validates words
    lastDefinitions: game.lastDefinitions || {},
    rounds: game.rounds || 0,
    maxRounds: game.maxRounds || MAX_ROUNDS,
    finalPhase: game.finalPhase || false,
    finalRemaining: game.finalRemaining || 0,
    ended: game.ended || false
  });
}

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("squword server running on port " + PORT);
});
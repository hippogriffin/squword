const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const db = new Low(new JSONFile('scrabble-db.json'), { games: {} });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BOARD_SIZE = 15;
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

io.on("connection", (socket) => {
  socket.on("join", async ({room, name, persistentId}) => {
    await db.read();
    db.data ||= { games: {} };

    let game = loadGameRoom(room);
    if (!game) {
      const SCRABBLE_TILE_COUNTS = {
            A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1,
            K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6,
            U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1
        };
    function buildTileBag() {
    const bag = [];
    for (const [letter, count] of Object.entries(SCRABBLE_TILE_COUNTS)) {
        for (let i = 0; i < count; i++) {
        bag.push(letter);
        }
    }
    return bag;
    }

    // In your game init:
    const tileBag = buildTileBag();
      game = {
        board: Array.from({length:BOARD_SIZE},()=>Array(BOARD_SIZE).fill("")),
        players: [],
        turnIdx: 0,
        tileBag,
        running: false
      };
    }
    let existingPlayer = persistentId ?
      (game.players || []).find(p => p.persistentId && p.persistentId === persistentId)
      : null;
    if (existingPlayer) {
      existingPlayer.id = socket.id;
      socket.join(room);
      socket.emit("join_ok", {id: socket.id, rackIdx: game.players.indexOf(existingPlayer)});
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
    socket.join(room);
    socket.emit("join_ok", {id: socket.id, rackIdx});
    game.running = game.players.length >= 2;
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

    const coords = placements.map(p => [p.row, p.col]);
    const allSameRow = coords.every(([r,_]) => r === coords[0][0]);
    const allSameCol = coords.every(([_,c]) => c === coords[0][1]);
    if (!(allSameRow || allSameCol)) {
      socket.emit("move_result",{ok:false,msg:"Tiles must be in straight line"}); return;
    }
    const sorted = (allSameRow ? coords.map(([_,c])=>c) : coords.map(([r,_])=>r)).slice().sort((a,b)=>a-b);
    for (let i=sorted[0]; i<=sorted[sorted.length-1]; i++){
      let r = allSameRow ? coords[0][0] : i;
      let c = allSameRow ? i : coords[0][1];
      if (
        !placements.some(p=>p.row===r && p.col===c) &&
        !game.board[r][c]
      ) {
        socket.emit("move_result",{ok:false,msg:"Tiles must be contiguous"}); return;
      }
    }

    async function validateAllWords() {
      const mainWord = getFullWord(game.board, placements);
      let wordsToCheck = mainWord ? [mainWord] : [];
      for (const cw of getCrossWords(game.board, placements)) {
        if (cw.word.length > 1) wordsToCheck.push(cw.word);
      }
      for (const word of wordsToCheck) {
        const valid = await isValidWordAPI(word);
        if (!valid) {
          socket.emit("move_result",{ok:false,msg:`'${word}' not valid!`}); return false;
        }
      }
      return true;
    }

    validateAllWords().then(async (valid)=>{
      if (!valid) return;

      const scoreObj = calculateWordScore(game.board, placements);
      game.players[playerIdx].score += scoreObj.total;

      for (const {row,col,letter,rackIdx} of placements) {
        game.board[row][col] = letter;
        game.players[playerIdx].rack[rackIdx] = null;
      }
      game.players[playerIdx].rack = game.players[playerIdx].rack.filter(x=>x);
      const drawCnt = 7 - game.players[playerIdx].rack.length;
      game.players[playerIdx].rack.push(...getInitialRack(game.tileBag, drawCnt));
      game.turnIdx = (game.turnIdx + 1) % game.players.length;
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
    const drawCnt = 7 - player.rack.filter(ltr => !!ltr).length;
    if (drawCnt > 0) {
      player.rack.push(...getInitialRack(game.tileBag, drawCnt));
    }
    game.turnIdx = (game.turnIdx + 1) % game.players.length;
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
  if (allSameRow) {
    const row = coords[0][0];
    let minCol = Math.min(...coords.map(([_,c]) => c));
    let maxCol = Math.max(...coords.map(([_,c]) => c));
    while (minCol > 0 && board[row][minCol-1]) minCol--;
    while (maxCol < BOARD_SIZE-1 && board[row][maxCol+1]) maxCol++;
    for (let col = minCol; col <= maxCol; ++col){
      const placed = placements.find(p=>p.row===row && p.col===col);
      word += placed ? placed.letter : (board[row][col] || '');
    }
  } else if (allSameCol){
    const col = coords[0][1];
    let minRow = Math.min(...coords.map(([r,_]) => r));
    let maxRow = Math.max(...coords.map(([r,_]) => r));
    while (minRow > 0 && board[minRow-1][col]) minRow--;
    while (maxRow < BOARD_SIZE-1 && board[maxRow+1][col]) maxRow++;
    for (let row=minRow; row<=maxRow; ++row){
      const placed = placements.find(p=>p.row===row && p.col===col);
      word += placed ? placed.letter : (board[row][col] || '');
    }
  }
  return word;
}

function getCrossWords(board, placements) {
  const crossWords = [];
  const coords = placements.map(p => [p.row, p.col]);
  const allSameRow = coords.every(([r,_]) => r === coords[0][0]);
  const allSameCol = coords.every(([_,c]) => c === coords[0][1]);
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
      while (r < BOARD_SIZE && (board[r][col] || placements.find(p=>p.row===r&&p.col===col))) {
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
      while (c < BOARD_SIZE && (board[row][c] || placements.find(p=>p.row===row&&p.col===c))) {
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
  function scoreOneWord(wordTiles) {
    let score = 0, wordMultipliers = [];
    for (const {letter, isNew, row, col} of wordTiles) {
      if (!letter) continue;
      let tileScore = LETTER_POINTS[letter.toUpperCase()] || 0;
      const bonus = BONUS_BOARD[row][col];
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
    while (minCol > 0 && board[row][minCol-1]) minCol--;
    while (maxCol < BOARD_SIZE-1 && board[row][maxCol+1]) maxCol++;
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
    while (minRow > 0 && board[minRow-1][col]) minRow--;
    while (maxRow < BOARD_SIZE-1 && board[maxRow+1][col]) maxRow++;
    for (let row = minRow; row <= maxRow; ++row) {
      let letter = null, isNew = false;
      const pending = placements.find(p => p.row === row && p.col === col);
      if (pending) { letter = pending.letter; isNew = true; }
      else if (board[row][col]) { letter = board[row][col]; isNew = false; }
      else { letter = null; }
      mainWordTiles.push({letter, isNew, row, col});
    }
  }
  let mainScore = scoreOneWord(mainWordTiles);
  let crossScores = 0;
  for (const {word, tiles} of getCrossWords(board, placements)) {
    if ((allSameRow && tiles.every(t=>t.row===coords[0][0])) ||
        (allSameCol && tiles.every(t=>t.col===coords[0][1]))) continue;
    crossScores += scoreOneWord(tiles);
  }
  return {mainScore, crossScores, total: mainScore + crossScores};
}

async function isValidWordAPI(word) {
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`);
    if (response.ok) {
      return true;
    } else {
      return false;
    }
  } catch {
    return false;
  }
}

function broadcastGame(room) {
  const game = games[room] || loadGameRoom(room);
  if (!game) return;
  io.to(room).emit("game_update", {
    board: game.board,
    turnIdx: game.turnIdx,
    players: game.players.map(p => ({name: p.name, rack: p.rack, score: p.score}))
  });
}

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Scrabble server running on port " + PORT);
});
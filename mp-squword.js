const socket = io();

let myId = null;
let myName = '';
let myRoom = '';
let myRackIdx = -1;
let gameState = null;
let pendingPlacements = [];
let hasSeenLastTurnPopup = false;

const BONUS_BOARD = [
  ["TW","","","DL","","","","TW","","","","DL","","","TW"],
  ["","DW","","","","TL","","","","TL","","","","DW",""],
  ["","","DW","","","","DL","","DL","","","","DW","",""],
  ["DL","","","DW","","","","DL","","","","DW","","","DL"],
  ["","","","","DW","","","","","","DW","","",""],
  ["","TL","","","","TL","","","","TL","","","","TL",""],
  ["","","DL","","","","DL","","DL","","","","DL","",""],
  ["TW","","","DL","","","","CENTER","","","","DL","","","TW"],
  ["","","DL","","","","DL","","DL","","","","DL","",""],
  ["","TL","","","","TL","","","","TL","","","","TL",""],
  ["","","","","DW","","","","","","DW","","",""],
  ["DL","","","DW","","","","DL","","","","DW","","","DL"],
  ["","","DW","","","","DL","","DL","","","","DW","",""],
  ["","DW","","","","TL","","","","TL","","","","DW",""],
  ["TW","","","DL","","","","TW","","","","DL","","","TW"]
];

const squword_TILE_COUNTS = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1,
  K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6,
  U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1
};

function getPersistentId() {
  let persistentId = localStorage.getItem('squwordPID');
  if (!persistentId) {
    persistentId = Math.random().toString(36).substr(2);
    localStorage.setItem('squwordPID', persistentId);
  }
  return persistentId;
}

function joinGame() {
  myName = document.getElementById('nickname').value || ('Player' + Math.floor(Math.random()*1000));
  myRoom = document.getElementById('room').value || 'default';
  let persistentId = getPersistentId();
  document.getElementById('conn-status').textContent = "Joining room...";
  // Read optional game settings (first player can override)
  const boardSize = parseInt(document.getElementById('boardSize')?.value || '15');
  const rounds = parseInt(document.getElementById('rounds')?.value || '12');
  const joinCode = (document.getElementById('joinCode') && document.getElementById('joinCode').value) || undefined;
  socket.emit('join', {room: myRoom, name: myName, persistentId, boardSize, rounds, joinCode});
}

document.getElementById('joinBtn').onclick = joinGame;

socket.on('join_ok', ({id, rackIdx}) => {
  myId = id;
  myRackIdx = rackIdx;
  document.getElementById('conn-status').textContent = "Connected. Waiting for game...";
});

socket.on('join_ok', ({id, rackIdx, joinCode}) => {
  // If server returned a joinCode (room created), display it so the creator can share
  if (joinCode) {
    const cs = document.getElementById('conn-status');
    if (cs) cs.textContent = "Room created. Share this code to allow others to join.";
    const jca = document.getElementById('join-code-area');
    const jcdisp = document.getElementById('joinCodeDisplay');
    if (jca && jcdisp) {
      jcdisp.value = joinCode;
      jca.classList.remove('hidden');
    }
    const copyBtn = document.getElementById('copyJoinCodeBtn');
    if (copyBtn) copyBtn.onclick = () => {
      try { navigator.clipboard.writeText(joinCode); copyBtn.textContent = 'Copied'; setTimeout(()=>copyBtn.textContent='Copy',1500); }
      catch(e){
        // fallback
        jcdisp.select(); document.execCommand('copy'); copyBtn.textContent='Copied'; setTimeout(()=>copyBtn.textContent='Copy',1500);
      }
    };
  }
});

socket.on('join_denied', ({msg}) => {
  const cs = document.getElementById('conn-status');
  if (cs) cs.textContent = `Join denied: ${msg}`;
});

socket.on('game_update', state => {
  gameState = state;
  document.getElementById('connection-area').style.display = 'none';
  document.getElementById('game').style.display = '';
  pendingPlacements = [];
  // Show last-turn popup when appropriate
  try {
    const imMyTurn = gameState.turnIdx === myRackIdx;
    const isFinalPhaseLastTurn = gameState.finalPhase && imMyTurn && (gameState.finalRemaining === 1);
    const isRoundLimitLastTurn = imMyTurn && (gameState.rounds >= ((gameState.maxRounds || 12) - 1));
    if ((isFinalPhaseLastTurn || isRoundLimitLastTurn) && !hasSeenLastTurnPopup) {
      hasSeenLastTurnPopup = true;
      alert('This is your last turn before the game ends.');
    }
  } catch (e) {}
  renderGame();
  // Show end-of-game banner if the server indicates the game ended
  try {
    if (gameState.ended) {
      const winners = gameState.winners || [];
      const winnerNames = winners.map(i => (gameState.players && gameState.players[i]) ? gameState.players[i].name : 'Unknown');
      const winnerText = winnerNames.length === 1 ? `${winnerNames[0]} is the winner` : `${winnerNames.join(', ')} are the winners`;
      document.getElementById('end-winner').textContent = winnerText;
      document.getElementById('end-banner').classList.remove('hidden');
    }
  } catch (e) {}
});

// Close button for end banner
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'end-close') {
    const banner = document.getElementById('end-banner');
    if (banner) banner.classList.add('hidden');
  }
});

socket.on('move_result', ({ok, msg}) => {
  if (!ok) alert(msg);
});

function sendMove() {
  socket.emit('play_tiles', {
    placements: pendingPlacements,
    room: myRoom
  });
}

function sendSkipTurn() {
  socket.emit('skip_turn', { room: myRoom });
}

function handleTileDragStart(e, letter, rackIdx) {
  e.dataTransfer.setData("type", "rack");
  e.dataTransfer.setData("letter", letter);
  e.dataTransfer.setData("rackIdx", rackIdx);
}

function handlePendingTileDragStart(e, pendingTile, fromRow, fromCol) {
  e.dataTransfer.setData("type", "pending");
  e.dataTransfer.setData("letter", pendingTile.letter);
  e.dataTransfer.setData("rackIdx", pendingTile.rackIdx);
  e.dataTransfer.setData("fromRow", fromRow);
  e.dataTransfer.setData("fromCol", fromCol);
}

function handleBoardDrop(e, row, col, cell) {
  e.preventDefault();
  cell.style.background = '';
  const type = e.dataTransfer.getData("type");
  const letter = e.dataTransfer.getData("letter");
  const rackIdx = parseInt(e.dataTransfer.getData("rackIdx"));
  if (gameState.board[row][col] || pendingPlacements.find(p => p.row === row && p.col === col)) return;
  if (type === "rack") {
    pendingPlacements.push({ row, col, letter, rackIdx });
  } else if (type === "pending") {
    const fromRow = parseInt(e.dataTransfer.getData("fromRow"));
    const fromCol = parseInt(e.dataTransfer.getData("fromCol"));
    const i = pendingPlacements.findIndex(
      p => p.row === fromRow && p.col === fromCol && p.rackIdx === rackIdx
    );
    if (i >= 0) {
      pendingPlacements.splice(i, 1, { row, col, letter, rackIdx });
    }
  }
  renderGame();
}

function handleRackDrop(e, rackDiv) {
  e.preventDefault();
  rackDiv.style.background = "";
  const type = e.dataTransfer.getData("type");
  if (type !== "pending") return;
  const rackIdx = parseInt(e.dataTransfer.getData("rackIdx"));
  const fromRow = parseInt(e.dataTransfer.getData("fromRow"));
  const fromCol = parseInt(e.dataTransfer.getData("fromCol"));
  const i = pendingPlacements.findIndex(
    p => p.row === fromRow && p.col === fromCol && p.rackIdx === rackIdx
  );
  if (i >= 0) pendingPlacements.splice(i, 1);
  renderGame();
}

function reorderRackArray(arr, fromIdx, toIdx) {
  const a = Array.from({length:7}, (_,i) => (typeof arr[i] !== 'undefined') ? arr[i] : null);
  if (fromIdx === toIdx) return a;
  const val = a[fromIdx];
  // remove from fromIdx
  a.splice(fromIdx, 1);
  // insert at toIdx
  a.splice(toIdx, 0, val);
  // ensure length 7
  while (a.length < 7) a.push(null);
  return a.slice(0,7);
}

function handleRackSlotDrop(e, targetIdx) {
  e.preventDefault();
  // clear any visual highlight
  try { e.currentTarget.style.background = ''; } catch (err) {}
  const type = e.dataTransfer.getData('type');
  // If there are pending placements, disallow reordering to avoid confusing rackIdx mappings
  if (type === 'rack' && pendingPlacements && pendingPlacements.length > 0) {
    alert('Finish or clear any pending tiles on the board before reordering your rack.');
    return;
  }

  if (!gameState || !gameState.players || typeof gameState.players[myRackIdx] === 'undefined') return;
  const myPlayer = gameState.players[myRackIdx];
  myPlayer.rack = Array.from({length:7}, (_,i) => (myPlayer.rack && typeof myPlayer.rack[i] !== 'undefined') ? myPlayer.rack[i] : null);

    if (type === 'rack') {
    const fromIdx = parseInt(e.dataTransfer.getData('rackIdx'));
    if (isNaN(fromIdx)) return;
    // perform move
    myPlayer.rack = reorderRackArray(myPlayer.rack, fromIdx, targetIdx);
    // inform server of reorder so it's persisted and others see it
    try { socket.emit('reorder_rack', { room: myRoom, rack: myPlayer.rack }); } catch (err) {}
    renderGame();
  } else if (type === 'pending') {
    // dropping a pending tile back into a specific rack slot
    const rackIdx = parseInt(e.dataTransfer.getData('rackIdx'));
    const fromRow = parseInt(e.dataTransfer.getData('fromRow'));
    const fromCol = parseInt(e.dataTransfer.getData('fromCol'));
    const letter = e.dataTransfer.getData('letter');
    const i = pendingPlacements.findIndex(
      p => p.row === fromRow && p.col === fromCol && Number(p.rackIdx) === rackIdx
    );
    if (i >= 0) pendingPlacements.splice(i, 1);
    // put the letter into the target slot, clear the origin slot (origin should already be null)
    myPlayer.rack[targetIdx] = letter;
    // if origin index exists and different, ensure it's null
    if (!isNaN(rackIdx) && rackIdx !== targetIdx) myPlayer.rack[rackIdx] = null;
    // inform server of the updated rack
    try { socket.emit('reorder_rack', { room: myRoom, rack: myPlayer.rack }); } catch (err) {}
    renderGame();
  }
}

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

function getFullWordTiles(board, placements) {
  if (!board || !Array.isArray(board) || board.length === 0) return [];
  if (!Array.isArray(placements) || placements.length === 0) return [];
  const coords = placements.map(p => [Number(p.row), Number(p.col)]);
  const allSameRow = coords.every(([r,_]) => r === coords[0][0]);
  const allSameCol = coords.every(([_,c]) => c === coords[0][1]);
  let wordTiles = [];
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
      wordTiles.push({letter, isNew, row, col});
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
      wordTiles.push({letter, isNew, row, col});
    }
  }
  return wordTiles;
}

function getCrossWords(board, placements) {
  const crossWords = [];
  if (!board || !Array.isArray(board) || board.length === 0) return crossWords;
  if (!placements || !placements.length) return crossWords;
  const coords = placements.map(p => [Number(p.row), Number(p.col)]);
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
  if (!board || !Array.isArray(board) || board.length === 0) return {mainScore:0, crossScores:0, total:0, crossWords:[]};
  if (!placements || !Array.isArray(placements) || placements.length === 0) return {mainScore:0, crossScores:0, total:0, crossWords:[]};

  let mainWordTiles = getFullWordTiles(board, placements);
  let mainScore = scoreOneWord(mainWordTiles);

  // Crosswords from new tiles
  const coords = placements.map(p => [p.row, p.col]);
  // ensure coords are numbers
  const numCoords = coords.map(([r,c])=>[Number(r),Number(c)]);
  const allSameRow = coords.every(([r,_]) => r === coords[0][0]);
  const allSameCol = coords.every(([_,c]) => c === coords[0][1]);
  const crossWords = getCrossWords(board, placements);

  let crossScores = 0;
  for (const {word, tiles} of crossWords) {
    if ((allSameRow && tiles.every(t => t.row === numCoords[0][0])) ||
        (allSameCol && tiles.every(t => t.col === numCoords[0][1]))) continue;
    crossScores += scoreOneWord(tiles);
  }
  return {mainScore, crossScores, total: mainScore + crossScores, crossWords};
}

function renderGame() {
  // Defensive: ensure we have a game state and a board
  if (!gameState || !gameState.board || !Array.isArray(gameState.board)) return;
  // Board rendering
  const boardDiv = document.getElementById('board');
  boardDiv.innerHTML = "";
  const numRows = gameState.board.length;
  const numCols = gameState.board[0] ? gameState.board[0].length : 0;
  // Compute a sensible cell size so the board fits the viewport while
  // preserving the visual scale from the CSS breakpoints. We base the
  // desired total board width on the default 15x cell sizes from CSS,
  // then scale per the actual number of columns.
  const viewportW = window.innerWidth || 1200;
  const baseCell = (viewportW <= 950) ? 28 : (viewportW <= 1200) ? 40 : 56;
  const desiredTotal = baseCell * 15; // default total width used in CSS
  let cellSize = Math.floor(desiredTotal / Math.max(1, numCols));
  // clamp to a reasonable range
  cellSize = Math.max(18, Math.min(baseCell, cellSize));
  // Apply grid template dynamically
  boardDiv.style.gridTemplateColumns = `repeat(${numCols}, ${cellSize}px)`;
  boardDiv.style.gridTemplateRows = `repeat(${numRows}, ${cellSize}px)`;
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      let cell = document.createElement('span');
    cell.className = 'square';
  const bonus = (BONUS_BOARD[row] && BONUS_BOARD[row][col]) ? BONUS_BOARD[row][col] : '';
    // Inline tile sizing to match the dynamic grid
    cell.style.width = cell.style.height = cell.style.lineHeight = `${cellSize}px`;
    cell.style.fontSize = `${Math.max(12, Math.floor(cellSize * 0.5))}px`;
      if      (bonus === "TW") cell.classList.add("tw");
      else if (bonus === "DW") cell.classList.add("dw");
      else if (bonus === "TL") cell.classList.add("tl");
      else if (bonus === "DL") cell.classList.add("dl");
      else if (bonus === "CENTER") cell.classList.add("center");
      cell.dataset.row = row;
      cell.dataset.col = col;
      cell.setAttribute("data-empty","true");

      if (gameState.board[row] && gameState.board[row][col]) {
        cell.textContent = gameState.board[row][col];
        cell.removeAttribute("data-empty");
      }
      const pendingTile = pendingPlacements.find(p=>Number(p.row)===row&&Number(p.col)===col);
      if (pendingTile) {
        cell.textContent = pendingTile.letter;
        cell.removeAttribute("data-empty");
      }
    if (gameState.turnIdx === myRackIdx &&
      !pendingTile && !(gameState.board[row] && gameState.board[row][col])) {
        cell.ondragover = (e) => { e.preventDefault(); cell.style.background = "#eccc68"; };
        cell.ondragleave = (e) => { e.preventDefault(); cell.style.background = ''; };
        cell.ondrop = (e) => handleBoardDrop(e, row, col, cell);
      }
      if (pendingTile && gameState.turnIdx === myRackIdx) {
        cell.draggable = true;
        cell.style.cursor = 'grab';
        cell.ondragstart = (e) => handlePendingTileDragStart(e, pendingTile, row, col);
      }
      boardDiv.appendChild(cell);
    }
  }

  // YOUR RACK - bottom center (guarantee 7 slots with blanks if needed)
  const myRackDiv = document.getElementById('my-rack');
  myRackDiv.innerHTML = '';
  if (gameState.players && typeof gameState.players[myRackIdx] !== 'undefined') {
    const myPlayer = gameState.players[myRackIdx];
    // normalize rack to exactly 7 slots (use null for undefined/empty)
    const normalizedRack = Array.from({length:7}, (_,i) => (myPlayer.rack && typeof myPlayer.rack[i] !== 'undefined') ? myPlayer.rack[i] : null);
    for (let idx = 0; idx < 7; idx++) {
      const letter = normalizedRack[idx];
      const isPending = pendingPlacements.some(p => Number(p.rackIdx) === idx);
      if (letter === null || isPending) {
        // Blank: preserve shape
        const blankTile = document.createElement('span');
        blankTile.className = 'tile my-rack';
        // ensure display is flex even if CSS didn't apply for some reason
        blankTile.style.setProperty('display', 'flex', 'important');
        blankTile.style.opacity = '0.3';
        blankTile.textContent = '';
        // allow dropping rack or pending tiles onto this slot
        blankTile.ondragover = (e) => { e.preventDefault(); blankTile.style.background = '#eccc68'; };
        blankTile.ondragleave = () => { blankTile.style.background = ''; };
        blankTile.ondrop = (e) => handleRackSlotDrop(e, idx);
        myRackDiv.appendChild(blankTile);
      } else {
        const tile = document.createElement('span');
        tile.className = 'tile my-rack';
        // ensure display is flex even if CSS didn't apply for some reason
        tile.style.setProperty('display', 'flex', 'important');
        tile.textContent = letter;
        tile.draggable = true;
        tile.dataset.letter = letter;
        tile.dataset.rackIdx = idx;
        tile.ondragstart = (e) => handleTileDragStart(e, letter, idx);
        // allow dropping rack or pending tiles onto this slot (to reorder or reclaim)
        tile.ondragover = (e) => { e.preventDefault(); tile.style.background = '#eccc68'; };
        tile.ondragleave = () => { tile.style.background = ''; };
        tile.ondrop = (e) => handleRackSlotDrop(e, idx);
        myRackDiv.appendChild(tile);
      }
    }
    myRackDiv.ondragover = (e) => { e.preventDefault(); myRackDiv.style.background = "#eccc68"; };
    myRackDiv.ondragleave = () => myRackDiv.style.background = "";
    myRackDiv.ondrop = (e) => handleRackDrop(e, myRackDiv);
  }

  // ALL PLAYERS TRACKER - bottom right (including your own score)
  const trackerDiv = document.getElementById('player-tracker');
  trackerDiv.innerHTML = '';
  // Show join code in-game so players in the room can always see it
  try {
    if (gameState.joinCode) {
      const jcWrap = document.createElement('div');
      jcWrap.className = 'in-game-join-code';
      const codeInput = document.createElement('input');
      codeInput.readOnly = true;
      codeInput.className = 'join-input code-display in-game-code';
      codeInput.value = gameState.joinCode;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn in-game-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = () => {
        try { navigator.clipboard.writeText(gameState.joinCode); copyBtn.textContent = 'Copied'; setTimeout(()=>copyBtn.textContent='Copy',1500); }
        catch(e) { try { codeInput.select(); document.execCommand('copy'); copyBtn.textContent='Copied'; setTimeout(()=>copyBtn.textContent='Copy',1500); } catch(_){} }
      };
      jcWrap.appendChild(codeInput);
      jcWrap.appendChild(copyBtn);
      trackerDiv.appendChild(jcWrap);
    }
  } catch (e) {}
  // Display definitions (if the server provided them during last validation)
  try {
    const defBox = document.getElementById('definition-content');
    if (defBox) {
      defBox.innerHTML = '';
      if (gameState.lastDefinitions && Object.keys(gameState.lastDefinitions).length > 0) {
        for (const [word, defs] of Object.entries(gameState.lastDefinitions)) {
          const w = document.createElement('div');
          w.className = 'def-word';
          const title = document.createElement('div');
          title.style.fontWeight = '700';
          title.textContent = word;
          w.appendChild(title);
          if (Array.isArray(defs) && defs.length > 0) {
            const ul = document.createElement('ul');
            ul.style.margin = '6px 0 12px 18px';
            for (let i = 0; i < Math.min(defs.length, 4); i++) {
              const li = document.createElement('li');
              li.textContent = defs[i];
              ul.appendChild(li);
            }
            w.appendChild(ul);
          } else {
            const none = document.createElement('div');
            none.textContent = 'Definition not found.';
            w.appendChild(none);
          }
          defBox.appendChild(w);
        }
      } else {
        defBox.textContent = 'No word checked yet.';
      }
    }
  } catch (e) { /* don't let UI rendering errors break the game */ }
  (gameState.players || []).forEach((player, idx) => {
    const isMe = (idx === myRackIdx);
    const turnActive = (idx === gameState.turnIdx);
    const pDiv = document.createElement('div');
    pDiv.className = 'player-status' + (turnActive ? ' active' : '');
    pDiv.innerHTML = `
      ${isMe ? '<span style="color:#0b8;">You</span>' : player.name}
      ${turnActive ? ' 🔵' : ''}
      <span style="margin-left:8px;color:#444;">Score: ${player.score||0}</span>
    `;
    trackerDiv.appendChild(pDiv);
  });

  // Right-side Actions panel
  const actionsPanel = document.getElementById('actions-panel');
  actionsPanel.innerHTML = "";
  if (gameState.turnIdx === myRackIdx) {
    let scoreObj = calculateWordScore(gameState.board, pendingPlacements);

    let scoreSpan = document.createElement('div');
    scoreSpan.className = "score-preview";
    if (pendingPlacements.length > 0) {
      let cwStr = scoreObj.crossWords && scoreObj.crossWords.length
        ? ` + Cross: ${scoreObj.crossScores}` : '';
      scoreSpan.textContent =
        `Score: ${scoreObj.mainScore}${cwStr} → Turn Total: ${scoreObj.total}`;
    } else {
      scoreSpan.textContent = '';
    }
    actionsPanel.appendChild(scoreSpan);

    let playBtn = document.createElement('button');
    playBtn.textContent = "Submit Move";
    playBtn.onclick = sendMove;
    playBtn.disabled = pendingPlacements.length === 0;
    actionsPanel.appendChild(playBtn);

    let cancelBtn = document.createElement('button');
    cancelBtn.textContent = "Clear Move";
    cancelBtn.onclick = () => { pendingPlacements = []; renderGame(); };
    actionsPanel.appendChild(cancelBtn);

    let skipBtn = document.createElement('button');
    skipBtn.textContent = "Skip Turn";
    skipBtn.onclick = sendSkipTurn;
    actionsPanel.appendChild(skipBtn);
  }
}

// Real squword points
const LETTER_POINTS = {
  'A': 1, 'B': 3, 'C': 3, 'D': 2, 'E': 1, 'F': 4, 'G': 2, 'H': 4, 'I': 1,
  'J': 8, 'K': 5, 'L': 1, 'M': 3, 'N': 1, 'O': 1, 'P': 3, 'Q': 10, 'R': 1, 
  'S': 1, 'T': 1, 'U': 1, 'V': 4, 'W': 4, 'X': 8, 'Y': 4, 'Z': 10
};

window.onload = () => {
  renderGame();
};
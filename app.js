'use strict';
/* ============================================================
   Gomoku Arena —— 前端逻辑
   ============================================================ */

const SIZE = 15;
const COLS = 'ABCDEFGHIJKLMNO';
const EMPTY = 0, BLACK = 1, WHITE = 2;

const $ = (id) => document.getElementById(id);

const state = {
  tab: 'pve',
  mode: null,              // 'pve' | 'pvp'
  board: [],
  history: [],             // [{ row, col, who }]
  turn: BLACK,
  playing: false,
  aborted: false,
  humanColor: BLACK,
  winner: null,            // null | 1 | 2 | 'draw'
  winningLine: null,
  lastMove: null,
  pending: null,
  hover: null,
  waiting: false,
  // 系列赛
  series: 1,
  gameIndex: 1,
  scores: { a: 0, b: 0 },
  blackSide: 'a',          // 谁执黑
  cfgA: null,
  cfgB: null,
};

const protocolMap = { pve: 'openai', pvpA: 'openai', pvpB: 'openai' };

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

const notate = (r, c) => COLS[c] + (r + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const colorName = (v) => (v === BLACK ? '黑' : '白');

function emptyBoard() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(EMPTY));
}

/** 返回包含 (r,c) 的五连（及以上）坐标；无则返回 null */
function findWinLine(board, r, c) {
  const v = board[r][c];
  if (!v) return null;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    const cells = [[r, c]];
    for (let i = 1; i < SIZE; i++) {
      const nr = r + dr * i, nc = c + dc * i;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || board[nr][nc] !== v) break;
      cells.push([nr, nc]);
    }
    for (let i = 1; i < SIZE; i++) {
      const nr = r - dr * i, nc = c - dc * i;
      if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || board[nr][nc] !== v) break;
      cells.unshift([nr, nc]);
    }
    if (cells.length >= 5) return cells;
  }
  return null;
}

function boardFull(board) {
  return board.every((row) => row.every((v) => v !== EMPTY));
}

/* ------------------------------------------------------------------ *
 * 棋盘绘制
 * ------------------------------------------------------------------ */

const canvas = $('board');
const ctx = canvas.getContext('2d');
let geom = { pad: 20, cell: 30 };

function layoutBoard() {
  const cssW = canvas.parentElement.clientWidth;
  const w = Math.max(240, Math.min(cssW, 620));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.style.width = w + 'px';
  canvas.style.height = w + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(w * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = Math.max(16, w * 0.055);
  geom = { pad, cell: (w - pad * 2) / (SIZE - 1), w };
  return w;
}

function pointTo(r, c) {
  return { x: geom.pad + c * geom.cell, y: geom.pad + r * geom.cell };
}

function draw() {
  const w = geom.w;
  ctx.clearRect(0, 0, w, w);

  // 底板
  const g = ctx.createLinearGradient(0, 0, w, w);
  g.addColorStop(0, '#16203a');
  g.addColorStop(0.55, '#0e1526');
  g.addColorStop(1, '#131c31');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, w);

  const { pad, cell } = geom;
  const end = pad + cell * (SIZE - 1);

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < SIZE; i++) {
    const p = pad + i * cell;
    ctx.moveTo(pad, p); ctx.lineTo(end, p);
    ctx.moveTo(p, pad); ctx.lineTo(p, end);
  }
  ctx.stroke();

  // 外框
  ctx.strokeStyle = 'rgba(255,255,255,0.26)';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(pad, pad, end - pad, end - pad);

  // 星位
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (const [sr, sc] of [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]) {
    const { x, y } = pointTo(sr, sc);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, cell * 0.075), 0, Math.PI * 2);
    ctx.fill();
  }

  // 坐标标注
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = `${Math.max(9, Math.min(11, cell * 0.42))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < SIZE; i++) {
    const p = pad + i * cell;
    ctx.fillText(COLS[i], p, pad - cell * 0.52);
    ctx.fillText(String(i + 1), pad - cell * 0.62, p);
  }

  // 落子预览
  const preview = state.pending || state.hover;
  if (preview && state.board[preview.r][preview.c] === EMPTY && state.playing) {
    const { x, y } = pointTo(preview.r, preview.c);
    ctx.globalAlpha = state.pending ? 0.5 : 0.28;
    drawStone(x, y, cell * 0.44, state.turn);
    ctx.globalAlpha = 1;
    if (state.pending) {
      ctx.strokeStyle = 'rgba(55,226,213,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.46, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 棋子
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = state.board[r][c];
      if (!v) continue;
      const { x, y } = pointTo(r, c);
      drawStone(x, y, cell * 0.44, v);
    }
  }

  // 最后一手标记
  if (state.lastMove) {
    const { x, y } = pointTo(state.lastMove.row, state.lastMove.col);
    ctx.strokeStyle = state.lastMove.who === BLACK ? 'rgba(55,226,213,0.95)' : 'rgba(185,140,255,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 胜利连线
  if (state.winningLine && state.winningLine.length) {
    const a = pointTo(state.winningLine[0][0], state.winningLine[0][1]);
    const b = pointTo(state.winningLine[state.winningLine.length - 1][0], state.winningLine[state.winningLine.length - 1][1]);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,200,97,0.95)';
    ctx.lineWidth = Math.max(3, cell * 0.13);
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255,200,97,0.8)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawStone(x, y, r, who) {
  const grad = ctx.createRadialGradient(x - r * 0.34, y - r * 0.38, r * 0.12, x, y, r);
  if (who === BLACK) {
    grad.addColorStop(0, '#6d7794');
    grad.addColorStop(0.45, '#252b3a');
    grad.addColorStop(1, '#070a11');
  } else {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.5, '#eef1f8');
    grad.addColorStop(1, '#b3bccf');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = who === BLACK ? 'rgba(0,0,0,0.55)' : 'rgba(80,90,115,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function eventToCell(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (geom.w / rect.width);
  const y = (ev.clientY - rect.top) * (geom.w / rect.width);
  const c = Math.round((x - geom.pad) / geom.cell);
  const r = Math.round((y - geom.pad) / geom.cell);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
  const p = pointTo(r, c);
  if (Math.hypot(x - p.x, y - p.y) > geom.cell * 0.55) return null;
  return { r, c };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!state.playing || state.mode !== 'pve' || state.waiting || state.turn !== state.humanColor) return;
  const cell = eventToCell(ev);
  if (!cell) return;
  if (state.board[cell.r][cell.c] !== EMPTY) { state.pending = null; draw(); return; }
  // 移动端两步确认：第一次选中，再点同一位置落子
  if (!state.pending || state.pending.r !== cell.r || state.pending.c !== cell.c) {
    state.pending = cell;
    draw();
    return;
  }
  state.pending = null;
  humanPlay(cell.r, cell.c);
});

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType !== 'mouse') return;
  if (!state.playing || state.mode !== 'pve' || state.waiting || state.turn !== state.humanColor) { state.hover = null; return; }
  const cell = eventToCell(ev);
  const changed = (!!cell !== !!state.hover) || (cell && state.hover && (cell.r !== state.hover.r || cell.c !== state.hover.c));
  state.hover = cell && state.board[cell.r][cell.c] === EMPTY ? cell : null;
  if (changed) draw();
});

canvas.addEventListener('pointerleave', () => { state.hover = null; draw(); });

/* ------------------------------------------------------------------ *
 * 状态显示
 * ------------------------------------------------------------------ */

function updateTurnChip() {
  const chip = $('turnChip');
  chip.classList.remove('is-black', 'is-white', 'is-thinking');
  if (!state.playing) {
    $('turnText').textContent = '准备开始';
    return;
  }
  if (state.waiting) {
    chip.classList.add('is-thinking', state.turn === BLACK ? 'is-black' : 'is-white');
    const who = state.mode === 'pve'
      ? 'AI 思考中…'
      : `${sideName(state.turn === BLACK ? state.blackSide : other(state.blackSide))} 思考中…`;
    $('turnText').textContent = who;
    return;
  }
  chip.classList.add(state.turn === BLACK ? 'is-black' : 'is-white');
  if (state.mode === 'pve') {
    $('turnText').textContent = state.turn === state.humanColor ? `轮到你（${colorName(state.turn)}）` : 'AI 回合';
  } else {
    $('turnText').textContent = `${sideName(state.turn === BLACK ? state.blackSide : other(state.blackSide))}（${colorName(state.turn)}）`;
  }
}

const other = (s) => (s === 'a' ? 'b' : 'a');
function sideName(s) {
  if (state.mode === 'pvp') return s === 'a' ? (state.cfgA?.label || '模型 A') : (state.cfgB?.label || '模型 B');
  return s === 'a' ? '你' : 'AI';
}

function updateMeta() {
  const parts = [`手数 ${state.history.length}`, '15×15 无禁手'];
  if (state.mode === 'pvp' && state.series === 3) parts.unshift(`第 ${state.gameIndex} 局`);
  $('metaInfo').textContent = parts.join(' · ');
}

function updateScore() {
  const nums = [$('scoreA'), $('scoreB')];
  const sep = document.querySelector('.score-sep');
  if (state.mode === 'pvp') {
    $('scoreAName').textContent = state.cfgA?.label || '模型 A';
    $('scoreBName').textContent = state.cfgB?.label || '模型 B';
    $('scoreA').textContent = state.scores.a;
    $('scoreB').textContent = state.scores.b;
    nums.forEach((n) => { n.hidden = false; });
    sep.hidden = false;
  } else {
    $('scoreAName').textContent = '你';
    $('scoreBName').textContent = state.aiLabel || 'AI';
    nums.forEach((n) => { n.hidden = true; });
    sep.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

function addLog({ type = '', side = '', move = '', note = '', time = '' }) {
  const box = $('log');
  const emptyEl = box.querySelector('.log-empty');
  if (emptyEl) emptyEl.remove();
  const el = document.createElement('div');
  el.className = 'log-item' + (type ? ' ' + type : '') + (side === 'b' ? ' side-b' : '');
  el.innerHTML = `<div class="log-head"><span class="log-move">${move}</span>${time ? `<span class="log-time">${time}</span>` : ''}</div>${note ? `<div class="log-note">${note}</div>` : ''}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  $('log').innerHTML = '<div class="log-empty">还没有记录。开始一局后，模型的每一次思考都会显示在这里。</div>';
}

/* ------------------------------------------------------------------ *
 * 模型请求
 * ------------------------------------------------------------------ */

function historyNotation() {
  return state.history.map((h) => `${h.who === BLACK ? 'X' : 'O'}:${notate(h.row, h.col)}`);
}

async function requestMove(cfg, opts) {
  const resp = await fetch('/api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cfg,
      board: state.board,
      me: state.turn,
      history: historyNotation(),
      opts,
    }),
  });
  let data;
  try { data = await resp.json(); } catch { throw new Error(`服务返回异常 (HTTP ${resp.status})`); }
  if (!resp.ok || !data.ok) throw new Error(data.error || `请求失败 (HTTP ${resp.status})`);
  return data;
}

function collectCfg(kind) {
  const map = {
    pve: { prefix: 'pve', protoKey: 'pve' },
    pvpA: { prefix: 'pvp', suffix: 'A', protoKey: 'pvpA' },
    pvpB: { prefix: 'pvp', suffix: 'B', protoKey: 'pvpB' },
  };
  const m = map[kind];
  const s = m.suffix || '';
  const protocol = protocolMap[m.protoKey];
  const model = $(m.prefix + 'Model' + s).value.trim();
  const strengthId = kind === 'pve' ? 'pveStrength' : 'pvpStrength';
  const noise = protocol === 'local' ? (1 - Number($(strengthId).value) / 100) * 1.2 : 0;
  return {
    protocol,
    baseUrl: $(m.prefix + 'Base' + s).value.trim(),
    apiKey: $(m.prefix + 'Key' + s).value.trim(),
    model,
    temperature: Number(kind === 'pve' ? $('pveTemp').value : ($('pvpTempToggle').checked ? 0.6 : 0)),
    maxTokens: 4096,
    noise,
    label: protocol === 'local' ? '内置引擎' : (model || '未命名模型'),
  };
}

/* ------------------------------------------------------------------ *
 * 结算弹层
 * ------------------------------------------------------------------ */

function showOverlay({ icon, title, desc, primary, secondary }) {
  $('overlayIcon').textContent = icon;
  $('overlayTitle').textContent = title;
  $('overlayDesc').textContent = desc;
  $('overlayPrimary').textContent = primary.text;
  $('overlayPrimary').onclick = primary.onClick;
  if (secondary) {
    $('overlaySecondary').hidden = false;
    $('overlaySecondary').textContent = secondary.text;
    $('overlaySecondary').onclick = secondary.onClick;
  } else {
    $('overlaySecondary').hidden = true;
  }
  $('boardOverlay').classList.add('show');
}

function hideOverlay() { $('boardOverlay').classList.remove('show'); }

function endGame(winner, extra = '') {
  state.playing = false;
  state.waiting = false;
  state.winner = winner;
  updateTurnChip();
  $('btnStop').hidden = true;
  $('btnStopPvp').hidden = true;
  $('btnStartPve').hidden = false;
  $('btnStartPvp').hidden = false;
  $('btnUndo').disabled = true;
  canvas.classList.add('disabled');

  if (state.mode === 'pve') {
    let icon = '🏆', title, desc;
    if (winner === state.humanColor) { title = '你赢了'; desc = `击败 AI（${state.aiLabel}）${extra}`; }
    else if (winner === 'draw') { icon = '🤝'; title = '平局'; desc = '棋盘已满，双方握手言和'; }
    else { icon = '🤖'; title = 'AI 获胜'; desc = `${state.aiLabel} 赢下了这局${extra}`; }
    showOverlay({
      icon, title, desc,
      primary: { text: '再来一局', onClick: () => { hideOverlay(); startPve(); } },
      secondary: { text: '关闭', onClick: hideOverlay },
    });
  } else {
    const winSide = winner === BLACK ? state.blackSide : other(state.blackSide);
    const winName = sideName(winSide);
    let icon = '🏆', title, desc;
    if (winner === 'draw') { icon = '🤝'; title = '平局'; desc = '棋盘已满，和棋'; }
    else { title = `${winName} 获胜`; desc = `执${colorName(winner)}取胜${extra}`; }
    showOverlay({
      icon, title, desc,
      primary: { text: '再来一局', onClick: () => { hideOverlay(); startPvpSeries(); } },
      secondary: { text: '关闭', onClick: hideOverlay },
    });
  }
}

function failGame(msg) {
  state.playing = false;
  state.waiting = false;
  $('btnStop').hidden = true;
  $('btnStopPvp').hidden = true;
  $('btnStartPve').hidden = false;
  $('btnStartPvp').hidden = false;
  updateTurnChip();
  showOverlay({
    icon: '⚠️', title: '对局中断', desc: msg,
    primary: { text: '知道了', onClick: hideOverlay },
  });
}

/* ------------------------------------------------------------------ *
 * 人机对战
 * ------------------------------------------------------------------ */

function resetBoard() {
  state.board = emptyBoard();
  state.history = [];
  state.winner = null;
  state.winningLine = null;
  state.lastMove = null;
  state.pending = null;
  state.hover = null;
  state.turn = BLACK;
  canvas.classList.remove('disabled');
  updateMeta();
  draw();
}

async function startPve() {
  state.mode = 'pve';
  const cfg = collectCfg('pve');
  state.aiCfg = cfg;
  state.aiLabel = cfg.protocol === 'local' ? '内置引擎' : cfg.label;
  state.humanColor = Number(document.querySelector('#segHumanColor .is-active').dataset.val);
  state.scores = { a: 0, b: 0 };
  resetBoard();
  updateScore();
  state.playing = true;
  state.aborted = false;
  $('btnStartPve').hidden = true;
  $('btnStop').hidden = false;
  $('btnUndo').disabled = true;
  addLog({ type: 'sys', move: '开局', note: `人机对战：你执${colorName(state.humanColor)}，AI 为 <code>${escapeHtml(state.aiLabel)}</code>` });
  updateTurnChip();
  if (state.turn !== state.humanColor) await aiTurn();
}

async function humanPlay(r, c) {
  if (!state.playing || state.board[r][c] !== EMPTY) return;
  applyMove(r, c, state.humanColor, '你');
  if (checkEnd()) return;
  state.turn = state.humanColor === BLACK ? WHITE : BLACK;
  updateTurnChip();
  await aiTurn();
}

async function aiTurn() {
  if (!state.playing || state.aborted) return;
  const aiColor = state.humanColor === BLACK ? WHITE : BLACK;
  state.turn = aiColor;
  state.waiting = true;
  updateTurnChip();
  draw();
  try {
    const data = await requestMove(state.aiCfg, {
      timeout: Number($('pveTime').value),
      useHint: $('pveHint').checked,
      withReason: $('pveReason').checked,
    });
    state.waiting = false;
    if (state.aborted) return;
    const { row, col } = data.move;
    const n = state.history.length + 1;
    applyMove(row, col, aiColor, state.aiLabel);
    const note = buildNote(data);
    addLog({ side: 'b', move: `${n}. ${notate(row, col)}`, note, time: `${(data.meta.latencyMs / 1000).toFixed(1)}s` });
    if (data.source === 'fallback') addLog({ type: 'warn', move: '兜底', note: data.warn || '模型输出不可用，已由内置引擎代下' });
    if (checkEnd()) return;
    state.turn = state.humanColor;
    $('btnUndo').disabled = false;
    updateTurnChip();
    draw();
  } catch (e) {
    state.waiting = false;
    addLog({ type: 'err', move: '错误', note: escapeHtml(e.message) });
    failGame(e.message);
  }
}

function buildNote(data) {
  const bits = [];
  if (data.reason) bits.push(escapeHtml(data.reason));
  const raw = (data.raw || '').replace(/\s+/g, ' ').slice(0, 160);
  if (raw && raw !== data.reason) bits.push(`<code>${escapeHtml(raw)}</code>`);
  if (data.usage?.total_tokens) bits.push(`tokens ${data.usage.total_tokens}`);
  return bits.join(' · ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function applyMove(r, c, who, label) {
  state.board[r][c] = who;
  state.history.push({ row: r, col: c, who, label });
  state.lastMove = { row: r, col: c, who };
  const line = findWinLine(state.board, r, c);
  if (line) { state.winningLine = line; }
  updateMeta();
  draw();
}

function checkEnd() {
  if (state.winningLine) {
    const winner = state.board[state.winningLine[0][0]][state.winningLine[0][1]];
    endGame(winner, `，共 ${state.history.length} 手`);
    return true;
  }
  if (boardFull(state.board)) {
    endGame('draw');
    return true;
  }
  return false;
}

async function undoMove() {
  if (state.mode !== 'pve' || !state.playing || state.waiting) return;
  if (state.history.length < 2) return;
  // 撤回 AI 一手 + 自己一手
  for (let i = 0; i < 2; i++) {
    const last = state.history.pop();
    state.board[last.row][last.col] = EMPTY;
  }
  state.lastMove = state.history.length ? { ...state.history[state.history.length - 1] } : null;
  state.winningLine = null;
  state.turn = state.humanColor;
  state.pending = null;
  $('btnUndo').disabled = state.history.length < 2;
  updateMeta();
  updateTurnChip();
  draw();
  addLog({ type: 'sys', move: '悔棋', note: `回到第 ${state.history.length} 手` });
}

async function resign() {
  if (!state.playing) return;
  if (state.mode === 'pve') {
    endGame(state.humanColor === BLACK ? WHITE : BLACK, '（你认输了）');
  } else {
    const cur = state.turn === BLACK ? state.blackSide : other(state.blackSide);
    endGame(state.turn === BLACK ? WHITE : BLACK, `（${sideName(cur)} 认输）`);
  }
}

/* ------------------------------------------------------------------ *
 * 模型对战
 * ------------------------------------------------------------------ */

async function startPvpSeries() {
  state.mode = 'pvp';
  state.cfgA = collectCfg('pvpA');
  state.cfgB = collectCfg('pvpB');
  state.series = Number(document.querySelector('#segSeries .is-active').dataset.val);
  state.scores = { a: 0, b: 0 };
  state.gameIndex = 1;
  state.blackSide = Math.random() < 0.5 ? 'a' : 'b';
  state.aborted = false;
  $('btnStartPvp').hidden = true;
  $('btnStopPvp').hidden = false;
  $('btnUndo').disabled = true;
  updateScore();
  addLog({
    type: 'sys',
    move: state.series === 3 ? '三局两胜' : '单局对战',
    note: `<code>${escapeHtml(state.cfgA.label)}</code> vs <code>${escapeHtml(state.cfgB.label)}</code> · 第 1 局 ${sideName(state.blackSide)} 执黑`,
  });

  while (state.gameIndex <= state.series && !state.aborted) {
    await runPvpGame();
    if (state.aborted) return;
    const winSide = state.winner === 'draw' ? null : (state.winner === BLACK ? state.blackSide : other(state.blackSide));
    if (winSide) state.scores[winSide] += 1;
    updateScore();
    addLog({
      type: 'sys',
      move: `第 ${state.gameIndex} 局结束`,
      note: winSide ? `${sideName(winSide)} 胜 · 比分 ${state.scores.a}:${state.scores.b}` : `和棋 · 比分 ${state.scores.a}:${state.scores.b}`,
    });

    if (state.series === 1) { /* 单局：endGame 已弹出结算，不再覆盖 */ return; }
    if (state.scores.a >= 2 || state.scores.b >= 2) break;
    state.gameIndex += 1;
    state.blackSide = other(state.blackSide);
    if ($('pvpAutoNext').checked) {
      hideOverlay();
      await sleep(1800);
    } else {
      showOverlay({
        icon: '⚖️', title: `第 ${state.gameIndex} 局`,
        desc: `当前比分 ${state.scores.a}:${state.scores.b} · 本局 ${sideName(state.blackSide)} 执黑`,
        primary: { text: '开始下一局', onClick: () => { hideOverlay(); runPvpGame().then(afterSingleGame); } },
        secondary: { text: '结束系列赛', onClick: () => { state.aborted = true; hideOverlay(); finishSeries(); } },
      });
      return;
    }
  }
  finishSeries();
}

function afterSingleGame() {
  if (state.aborted) return;
  const winSide = state.winner === 'draw' ? null : (state.winner === BLACK ? state.blackSide : other(state.blackSide));
  if (winSide) state.scores[winSide] += 1;
  updateScore();
  if (state.scores.a >= 2 || state.scores.b >= 2 || state.gameIndex >= state.series) { finishSeries(); return; }
  state.gameIndex += 1;
  state.blackSide = other(state.blackSide);
  showOverlay({
    icon: '⚖️', title: `第 ${state.gameIndex} 局`,
    desc: `当前比分 ${state.scores.a}:${state.scores.b} · 本局 ${sideName(state.blackSide)} 执黑`,
    primary: { text: '开始下一局', onClick: () => { hideOverlay(); runPvpGame().then(afterSingleGame); } },
    secondary: { text: '结束系列赛', onClick: () => { state.aborted = true; hideOverlay(); finishSeries(); } },
  });
}

function finishSeries() {
  state.playing = false;
  state.waiting = false;
  $('btnStopPvp').hidden = true;
  $('btnStartPvp').hidden = false;
  updateTurnChip();
  const nameA = state.cfgA?.label || '模型 A';
  const nameB = state.cfgB?.label || '模型 B';
  let icon = '🏆', title, desc;
  if (state.scores.a > state.scores.b) { title = `${nameA} 赢得系列赛`; desc = `总比分 ${state.scores.a} : ${state.scores.b}`; }
  else if (state.scores.b > state.scores.a) { title = `${nameB} 赢得系列赛`; desc = `总比分 ${state.scores.b} : ${state.scores.a}`; }
  else { icon = '🤝'; title = '系列赛打平'; desc = `总比分 ${state.scores.a} : ${state.scores.b}`; }
  addLog({ type: 'sys', move: '系列赛结束', note: `${title} · ${desc}` });
  showOverlay({
    icon, title, desc,
    primary: { text: '再来一轮', onClick: () => { hideOverlay(); startPvpSeries(); } },
    secondary: { text: '关闭', onClick: hideOverlay },
  });
}

async function runPvpGame() {
  resetBoard();
  state.playing = true;
  state.waiting = false;
  updateTurnChip();
  const delay = Number($('pvpDelay').value) * 1000;
  const opts = {
    timeout: Number($('pvpTime').value),
    useHint: $('pvpHint').checked,
    withReason: $('pvpReason').checked,
  };
  let guard = 0;

  while (state.playing && !state.aborted && guard++ < SIZE * SIZE) {
    const side = state.turn === BLACK ? state.blackSide : other(state.blackSide);
    const cfg = side === 'a' ? state.cfgA : state.cfgB;
    state.waiting = true;
    updateTurnChip();
    draw();
    let data;
    try {
      data = await requestMove(cfg, opts);
    } catch (e) {
      state.waiting = false;
      addLog({ type: 'err', move: '错误', note: `${sideName(side)}：${escapeHtml(e.message)}` });
      failGame(`${sideName(side)} 请求失败：${e.message}`);
      return;
    }
    if (state.aborted) { state.waiting = false; return; }
    state.waiting = false;
    const n = state.history.length + 1;
    const { row, col } = data.move;
    applyMove(row, col, state.turn, sideName(side));
    const note = buildNote(data);
    addLog({ side, move: `${n}. ${notate(row, col)}`, note, time: `${(data.meta.latencyMs / 1000).toFixed(1)}s` });
    if (data.source === 'fallback') addLog({ type: 'warn', move: '兜底', note: `${sideName(side)}：${data.warn || '输出不可用，引擎代下'}` });
    if (checkEnd()) return;
    state.turn = state.turn === BLACK ? WHITE : BLACK;
    updateTurnChip();
    if (delay > 0) await sleep(delay);
  }
}

/* ------------------------------------------------------------------ *
 * UI 初始化
 * ------------------------------------------------------------------ */

function initSelects() {
  const targets = [
    { sel: $('pvePreset'), kind: 'pve', base: 'pveBase', model: 'pveModel', key: 'pveKey' },
    { sel: $('pvpPresetA'), kind: 'pvpA', base: 'pvpBaseA', model: 'pvpModelA', key: 'pvpKeyA' },
    { sel: $('pvpPresetB'), kind: 'pvpB', base: 'pvpBaseB', model: 'pvpModelB', key: 'pvpKeyB' },
  ];
  for (const t of targets) {
    t.sel.innerHTML = window.PROVIDERS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    t.sel.addEventListener('change', () => applyPreset(t, t.sel.value, true, true));
  }
}

/** 应用预设：applyDefaults=true 时覆盖 URL/模型输入框；silent=true 时不写日志 */
function applyPreset(t, presetId, applyDefaults, silent) {
  const p = window.PROVIDERS.find((x) => x.id === presetId);
  if (!p) return;
  protocolMap[t.kind] = p.protocol;
  const isLocal = p.protocol === 'local';
  if (applyDefaults) {
    $(t.base).value = p.baseUrl || '';
    $(t.model).value = p.model || '';
    if (p.id === 'custom') $(t.key).value = '';
  }
  $(t.base).disabled = isLocal;
  $(t.model).disabled = isLocal;
  $(t.key).disabled = isLocal;
  $(t.key).placeholder = isLocal ? '无需 Key' : 'sk-...';
  if (saveConfigOnReady) saveConfig();
  if (!silent && p.tip) addLog({ type: 'sys', move: p.name, note: p.tip });
}

function initDatalist() {
  const set = new Set();
  window.PROVIDERS.forEach((p) => (p.models || []).forEach((m) => set.add(m)));
  $('modelList').innerHTML = [...set].map((m) => `<option value="${m}"></option>`).join('');
}

function initProviderList() {
  $('providerList').innerHTML = window.PROVIDERS.map((p) => `
    <div class="provider">
      <b>${p.name}</b>
      <div class="url">${p.baseUrl || (p.protocol === 'local' ? '本地内置，无需网络' : '自定义填写')}</div>
      <div class="models">常用模型：${(p.models || []).slice(0, 4).join('、') || '—'}</div>
      ${p.tip ? `<div class="tip">${p.tip}</div>` : ''}
    </div>`).join('');
}

function initSegs() {
  const bind = (wrapId, cb) => {
    const wrap = $(wrapId);
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      [...wrap.querySelectorAll('.seg-btn')].forEach((b) => b.classList.toggle('is-active', b === btn));
      cb(btn.dataset.val);
    });
  };
  bind('segHumanColor', () => { saveConfig(); });
  bind('segSeries', (v) => {
    $('seriesHint').textContent = v === '3'
      ? '三局两胜：第 1 局随机先后手，之后每局交换，先赢 2 局者获胜'
      : '单局：随机决定先后手';
    saveConfig();
  });
}

function initTabs() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === btn));
    document.querySelectorAll('.panel[data-panel]').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.panel === state.tab);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    requestAnimationFrame(() => { layoutBoard(); draw(); });
  });
}

function initButtons() {
  $('btnStartPve').addEventListener('click', () => { hideOverlay(); startPve(); });
  $('btnStartPvp').addEventListener('click', () => { hideOverlay(); startPvpSeries(); });
  $('btnStop').addEventListener('click', () => {
    state.aborted = true; state.playing = false; state.waiting = false;
    $('btnStop').hidden = true; $('btnStartPve').hidden = false;
    updateTurnChip();
    addLog({ type: 'sys', move: '已停止', note: '对局被手动终止' });
  });
  $('btnStopPvp').addEventListener('click', () => {
    state.aborted = true; state.playing = false; state.waiting = false;
    $('btnStopPvp').hidden = true; $('btnStartPvp').hidden = false;
    updateTurnChip();
    addLog({ type: 'sys', move: '已停止', note: '对战被手动终止' });
  });
  $('btnUndo').addEventListener('click', undoMove);
  $('btnResign').addEventListener('click', resign);
  $('btnClearLog').addEventListener('click', clearLog);

  document.querySelectorAll('[data-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.eye);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
    });
  });

  const RANGES = [
    ['pveTemp', 'pveTempOut', (v) => v],
    ['pveTime', 'pveTimeOut', (v) => v + 's'],
    ['pveStrength', 'pveStrengthOut', (v) => v + '%'],
    ['pvpDelay', 'pvpDelayOut', (v) => Number(v).toFixed(1) + 's'],
    ['pvpTime', 'pvpTimeOut', (v) => v + 's'],
    ['pvpStrength', 'pvpStrengthOut', (v) => v + '%'],
  ];
  window.syncOutputs = () => RANGES.forEach(([id, outId, fmt]) => { $(outId).textContent = fmt($(id).value); });
  RANGES.forEach(([id, outId, fmt]) => {
    const el = $(id);
    el.addEventListener('input', () => { $(outId).textContent = fmt(el.value); saveConfig(); });
  });
  window.syncOutputs();

  document.querySelectorAll('.input, .check input').forEach((el) => {
    el.addEventListener('change', saveConfig);
  });
}

const LS_KEY = 'gomoku-arena-config-v1';
let saveConfigOnReady = false;

function saveConfig() {
  if (!saveConfigOnReady) return;
  const data = {
    pvePreset: $('pvePreset').value, pveBase: $('pveBase').value, pveModel: $('pveModel').value, pveKey: $('pveKey').value,
    pvpPresetA: $('pvpPresetA').value, pvpBaseA: $('pvpBaseA').value, pvpModelA: $('pvpModelA').value, pvpKeyA: $('pvpKeyA').value,
    pvpPresetB: $('pvpPresetB').value, pvpBaseB: $('pvpBaseB').value, pvpModelB: $('pvpModelB').value, pvpKeyB: $('pvpKeyB').value,
    humanColor: document.querySelector('#segHumanColor .is-active')?.dataset.val,
    series: document.querySelector('#segSeries .is-active')?.dataset.val,
    pveTemp: $('pveTemp').value, pveTime: $('pveTime').value, pveStrength: $('pveStrength').value,
    pvpDelay: $('pvpDelay').value, pvpTime: $('pvpTime').value, pvpStrength: $('pvpStrength').value,
    pveHint: $('pveHint').checked, pveReason: $('pveReason').checked,
    pvpHint: $('pvpHint').checked, pvpReason: $('pvpReason').checked,
    pvpAutoNext: $('pvpAutoNext').checked, pvpTempToggle: $('pvpTempToggle').checked,
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* 隐私模式下忽略 */ }
}

const PRESET_TARGETS = [
  { sel: 'pvePreset', kind: 'pve', base: 'pveBase', model: 'pveModel', key: 'pveKey' },
  { sel: 'pvpPresetA', kind: 'pvpA', base: 'pvpBaseA', model: 'pvpModelA', key: 'pvpKeyA' },
  { sel: 'pvpPresetB', kind: 'pvpB', base: 'pvpBaseB', model: 'pvpModelB', key: 'pvpKeyB' },
];

function loadConfig() {
  let data;
  try { data = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { data = {}; }

  for (const t of PRESET_TARGETS) {
    const t2 = { ...t, sel: $(t.sel) };
    if (data[t.sel]) {
      $(t.sel).value = data[t.sel];
      applyPreset(t2, data[t.sel], false, true);   // 保留用户自己填过的 URL/模型
    } else {
      applyPreset(t2, $(t.sel).value, true, true); // 首次运行：填入预设默认值
    }
  }

  const set = (id, v) => { if (v != null) $(id).value = v; };
  ['pveBase', 'pveModel', 'pveKey', 'pvpBaseA', 'pvpModelA', 'pvpKeyA', 'pvpBaseB', 'pvpModelB', 'pvpKeyB',
    'pveTemp', 'pveTime', 'pveStrength', 'pvpDelay', 'pvpTime', 'pvpStrength'].forEach((id) => set(id, data[id]));
  const chk = (id, v) => { if (v != null) $(id).checked = !!v; };
  ['pveHint', 'pveReason', 'pvpHint', 'pvpReason', 'pvpAutoNext', 'pvpTempToggle'].forEach((id) => chk(id, data[id]));

  if (data.humanColor) {
    document.querySelectorAll('#segHumanColor .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.val === data.humanColor));
  }
  if (data.series === '3') {
    document.querySelectorAll('#segSeries .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.val === '3'));
    $('seriesHint').textContent = '三局两胜：第 1 局随机先后手，之后每局交换，先赢 2 局者获胜';
  }
  window.syncOutputs();
}

async function healthCheck() {
  const el = $('health');
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    if (d.ok) { el.textContent = '服务运行正常'; el.classList.add('ok'); }
  } catch {
    el.textContent = '未连接到本地服务（请运行 node server.js）';
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function boot() {
  state.board = emptyBoard();
  initSelects();
  initDatalist();
  initProviderList();
  initSegs();
  initTabs();
  initButtons();
  loadConfig();
  saveConfigOnReady = true;
  layoutBoard();
  draw();
  updateTurnChip();
  updateMeta();
  healthCheck();

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { layoutBoard(); draw(); }, 120);
  });
}

boot();

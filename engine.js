'use strict';
/**
 * Gomoku Arena —— 核心逻辑（棋盘 / 引擎 / Prompt / 解析 / 模型调用）
 * 不依赖任何第三方库。
 */

const SIZE = 15;
const COLS = 'ABCDEFGHIJKLMNO';
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

/* ---------------- 棋盘 ---------------- */

function emptyBoard() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

function inBoard(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function notation(r, c) {
  return COLS[c] + (r + 1);
}

/** 渲染成 ASCII 图，方便纯文本模型"看懂"局面 */
function renderBoard(board) {
  let s = '     ' + COLS.split('').join(' ') + '\n';
  for (let r = 0; r < SIZE; r++) {
    const cells = board[r].map((v) => (v === 1 ? 'X' : v === 2 ? 'O' : '.')).join(' ');
    s += String(r + 1).padStart(3, ' ') + '  ' + cells + '\n';
  }
  return s;
}

/** 返回包含 (r,c) 的五连及以上坐标，无则 null。who: 1=黑 2=白 */
function findWinLine(board, r, c) {
  const v = board[r][c];
  if (!v) return null;
  for (const [dr, dc] of DIRS) {
    const cells = [[r, c]];
    for (let i = 1; i < SIZE; i++) {
      const nr = r + dr * i, nc = c + dc * i;
      if (!inBoard(nr, nc) || board[nr][nc] !== v) break;
      cells.push([nr, nc]);
    }
    for (let i = 1; i < SIZE; i++) {
      const nr = r - dr * i, nc = c - dc * i;
      if (!inBoard(nr, nc) || board[nr][nc] !== v) break;
      cells.unshift([nr, nc]);
    }
    if (cells.length >= 5) return cells;
  }
  return null;
}

function boardFull(board) {
  return board.every((row) => row.every((v) => v !== 0));
}

/* ---------------- 内置启发式引擎 ---------------- *
 * 用「线模式匹配」评分：能识别成五 / 活四 / 冲四 / 活三 / 眠三 / 活二，
 * 也能识别跳三（XX_X）这类非连续形状，比单纯数连子强很多。
 * 字符串编码：1=自己的子，0=空点，2=对手子或棋盘外。
 */

const PATTERNS = [
  ['11111', 5000000],                                             // 成五
  ['011110', 400000],                                             // 活四
  ['11110', 30000], ['01111', 30000], ['11011', 30000],           // 冲四
  ['10111', 30000], ['11101', 30000],
  ['011100', 12000], ['001110', 12000], ['011010', 12000], ['010110', 12000], // 活三
  ['11100', 2500], ['00111', 2500], ['11010', 2500], ['01011', 2500],         // 眠三
  ['10110', 2500], ['01101', 2500], ['10011', 2500], ['11001', 2500],
  ['001100', 1500], ['001010', 1200], ['010100', 1200],           // 活二
  ['11000', 320], ['00011', 320], ['10100', 300], ['00101', 300], // 眠二
  ['10010', 300], ['01001', 300], ['10001', 280],
];

/** 以 (r,c) 为中心（视作已落 color），取该方向 9 格编码 */
function lineStr(board, r, c, dr, dc, color) {
  let s = '';
  for (let i = -4; i <= 4; i++) {
    const nr = r + dr * i, nc = c + dc * i;
    if (!inBoard(nr, nc)) { s += '2'; continue; }
    const v = board[nr][nc];
    if (i === 0) { s += '1'; continue; }   // 假设落子于此
    s += v === color ? '1' : v === 0 ? '0' : '2';
  }
  return s;
}

/** 该方向上落子后的形状得分（取匹配到的最高档） */
function dirScore(board, r, c, dr, dc, color) {
  const s = lineStr(board, r, c, dr, dc, color);
  for (let i = 0; i < PATTERNS.length; i++) {
    if (s.includes(PATTERNS[i][0])) return PATTERNS[i][1];
  }
  return 120;
}

function candidates(board) {
  const set = new Set();
  let any = false;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0) { any = true; continue; }
      let near = false;
      for (let dr = -2; dr <= 2 && !near; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nr = r + dr, nc = c + dc;
          if (inBoard(nr, nc) && board[nr][nc] !== 0) { near = true; break; }
        }
      }
      if (near) set.add(r * SIZE + c);
    }
  }
  if (!any) return [[7, 7]];
  if (!set.size) {
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (board[r][c] === 0) set.add(r * SIZE + c);
  }
  return [...set].map((v) => [Math.floor(v / SIZE), v % SIZE]);
}

function scoreAt(board, r, c, me, aggression = 1) {
  const opp = me === 1 ? 2 : 1;
  let my = 0, op = 0;
  let myThreats = 0, opThreats = 0;
  for (const [dr, dc] of DIRS) {
    const a = dirScore(board, r, c, dr, dc, me);
    const b = dirScore(board, r, c, dr, dc, opp);
    my += a; op += b;
    if (a >= 12000) myThreats++;   // 活三及以上
    if (b >= 12000) opThreats++;
  }
  // 双威胁（双三、三四）几乎必胜，大幅加成
  if (myThreats >= 2) my *= 2.6;
  if (opThreats >= 2) op *= 2.6;
  // 对手已有活三及以上威胁时提高防守权重，避免被反杀
  const defWeight = opThreats >= 1 ? 1.15 : 0.92;
  const centerBonus = 60 - (Math.abs(r - 7) + Math.abs(c - 7)) * 4;
  return my * aggression + op * defWeight + centerBonus;
}

function engineMove(board, me, opts = {}) {
  const noise = opts.noise || 0;
  const aggression = opts.aggression == null ? 1 : opts.aggression;
  const opp = me === 1 ? 2 : 1;
  const cands = candidates(board);

  // 硬规则 1：能一步成五就直接赢
  for (const [r, c] of cands) {
    board[r][c] = me;
    const w = findWinLine(board, r, c);
    board[r][c] = 0;
    if (w) return { row: r, col: c, score: 1e9 };
  }
  // 硬规则 2：对手一步成五必须堵
  for (const [r, c] of cands) {
    board[r][c] = opp;
    const w = findWinLine(board, r, c);
    board[r][c] = 0;
    if (w) return { row: r, col: c, score: 9e8 };
  }

  let best = null;
  let bestScore = -Infinity;
  for (const [r, c] of cands) {
    let score = scoreAt(board, r, c, me, aggression);
    if (noise > 0) score += Math.random() * noise * 30000;
    if (score > bestScore) { bestScore = score; best = { row: r, col: c }; }
  }
  if (!best) {
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (board[r][c] === 0) return { row: r, col: c, score: 0 };
    return null;
  }
  return { ...best, score: bestScore };
}

/** 给弱模型用的候选点提示 */
function hintMoves(board, me, n = 5) {
  const scored = candidates(board).map(([r, c]) => ({ r, c, s: scoreAt(board, r, c, me) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, n).map((x) => notation(x.r, x.c));
}

/* ---------------- Prompt ---------------- */

function buildPrompt({ board, me, history = [], hint = null, withReason = true, illegalNote = '' }) {
  const myMark = me === 1 ? 'X' : 'O';
  const oppMark = me === 1 ? 'O' : 'X';
  const myName = me === 1 ? '黑棋 (X)' : '白棋 (O)';
  const oppName = oppMark === 'X' ? '黑棋 (X)' : '白棋 (O)';

  const L = [];
  L.push('你在下五子棋（Gomoku / Five-in-a-Row），15x15 棋盘，标准无禁手规则。');
  L.push(`你执${myName}，对手执${oppName}。`);
  L.push('坐标规则：列用字母 A-O（从左到右），行用数字 1-15（从上到下）。例如 H8 表示第 H 列第 8 行。');
  L.push('获胜条件：横、竖、斜任意方向连成 5 子（或更多）即获胜。');
  L.push('');
  L.push('当前棋盘（X=黑棋，O=白棋，.=空点）：');
  L.push(renderBoard(board));
  L.push(`着法历史（先手在前，最新一手在最后）：${history.length ? history.join(' ') : '（无，你是先手）'}`);
  L.push('');
  if (hint && hint.length) {
    L.push(`参考：引擎算出的候选点有 ${hint.join('、')}，仅供你参考，最终落子由你自己判断。`);
  }
  L.push('请按以下优先级检查（这是赢棋的关键）：');
  L.push('1. 我是否能立刻连成 5 子？能就直接落子获胜。');
  L.push('2. 对手是否已经 4 连、下一手就能成 5？是则必须堵住那个空点。');
  L.push('3. 对手是否有"活三"（两端都能延伸成 4 的三连）？是则优先封堵或抢占关键点。');
  L.push('4. 否则：做自己的活三/活四，抢占交叉点，控制中心区域。');
  L.push('');
  if (illegalNote) {
    L.push(`【重要】你上一次的回复无法使用：${illegalNote}。请重新选择一个空点（棋盘上显示为 . 的位置）。`);
    L.push('');
  }
  L.push('输出格式（严格遵守，除以下内容外不要输出任何文字）：');
  if (withReason) {
    L.push('REASON: 一句话说明你的判断（不超过 25 字）');
    L.push('MOVE: <列字母><行数字>');
    L.push('例如：');
    L.push('REASON: 堵住对手的活三');
    L.push('MOVE: H8');
  } else {
    L.push('MOVE: <列字母><行数字>');
    L.push('例如：');
    L.push('MOVE: H8');
  }
  return L.join('\n');
}

/* ---------------- 着法解析（多层容错） ---------------- */

function parseMove(text, board) {
  if (!text) return null;
  const tries = [];
  const legal = (r, c) => inBoard(r, c) && board[r][c] === 0;
  const push = (r, c, source) => { if (legal(r, c)) tries.push({ row: r, col: c, source }); };
  const colIndex = (ch) => COLS.indexOf(String(ch).toUpperCase());

  // 1) JSON 风格
  const jsonPatterns = [
    [/^"move"/, /"move"\s*:\s*"([A-Oa-o])\s*[-_,]?\s*(\d{1,2})"/g],
    [/^"row"/, /"row"\s*:\s*(\d{1,2})\s*,\s*"col"\s*:\s*(\d{1,2})/g],
    [/^"col"/, /"col"\s*:\s*(\d{1,2})\s*,\s*"row"\s*:\s*(\d{1,2})/g],
    [/^"r"/, /"r"\s*:\s*(\d{1,2})\s*,\s*"c"\s*:\s*(\d{1,2})/g],
  ];
  for (const [test, re] of jsonPatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (test.test('"move"')) push(Number(m[2]) - 1, colIndex(m[1]), 'json-move');
      else if (test.test('"row"')) push(Number(m[1]) - 1, Number(m[2]) - 1, 'json-rowcol');
      else if (test.test('"col"')) push(Number(m[2]) - 1, Number(m[1]) - 1, 'json-colrow');
      else push(Number(m[1]) - 1, Number(m[2]) - 1, 'json-rc');
    }
  }

  // 2) 带 MOVE 关键字：MOVE: H8
  const reMove = /\bMOVE\b\s*[:=]?\s*(?:\[\s*)?([A-Oa-o])\s*[-_,]?\s*(\d{1,2})/gi;
  const hits = [];
  let m1;
  while ((m1 = reMove.exec(text)) !== null) hits.push(m1);
  for (let k = hits.length - 1; k >= 0; k--) push(Number(hits[k][2]) - 1, colIndex(hits[k][1]), 'keyword');

  // MOVE: 8,8
  const reMoveNum = /\bMOVE\b\s*[:=]?\s*\(?\s*(\d{1,2})\s*[,，\s]\s*(\d{1,2})\s*\)?/gi;
  let m2;
  const numHits = [];
  while ((m2 = reMoveNum.exec(text)) !== null) numHits.push(m2);
  for (let k = numHits.length - 1; k >= 0; k--) push(Number(numHits[k][1]) - 1, Number(numHits[k][2]) - 1, 'keyword-num');

  // 3) 裸坐标（从后往前，模型常在结尾给结论）
  const reBare = /\b([A-Oa-o])\s*[-_,]?\s*(\d{1,2})\b/g;
  let m3;
  const bare = [];
  while ((m3 = reBare.exec(text)) !== null) {
    const rr = Number(m3[2]) - 1, cc = colIndex(m3[1]);
    if (rr >= 0 && rr < SIZE && cc >= 0) bare.push([rr, cc]);
  }
  for (let k = bare.length - 1; k >= 0; k--) push(bare[k][0], bare[k][1], 'bare');

  // 4) 反序：8H
  const reRev = /\b(\d{1,2})\s*[-_,]?\s*([A-Oa-o])\b/g;
  let m4;
  const rev = [];
  while ((m4 = reRev.exec(text)) !== null) rev.push([Number(m4[1]) - 1, colIndex(m4[2])]);
  for (let k = rev.length - 1; k >= 0; k--) push(rev[k][0], rev[k][1], 'reversed');

  // 5) 纯数字对 (8,8)：先试 1-based，再试 0-based
  const rePair = /\(?\s*(\d{1,2})\s*[,，]\s*(\d{1,2})\s*\)?/g;
  let m5;
  const pairs = [];
  while ((m5 = rePair.exec(text)) !== null) pairs.push([Number(m5[1]), Number(m5[2])]);
  for (let k = pairs.length - 1; k >= 0; k--) {
    push(pairs[k][0] - 1, pairs[k][1] - 1, 'pair-1based');
    push(pairs[k][0], pairs[k][1], 'pair-0based');
  }

  return tries.length ? tries[0] : null;
}

function illegalReason(text, board) {
  const m = /\b([A-Oa-o])\s*[-_,]?\s*(\d{1,2})\b/.exec(text || '');
  if (!m) return '没有找到任何符合格式的坐标';
  const c = COLS.indexOf(m[1].toUpperCase());
  const r = Number(m[2]) - 1;
  if (!inBoard(r, c)) return `坐标 ${m[0]} 超出棋盘范围（列 A-O，行 1-15）`;
  if (board[r][c] !== 0) return `坐标 ${m[0]} 已经有棋子了，只能落在空点上`;
  return '坐标不合法';
}

/* ---------------- 模型调用 ---------------- */

function isReasoningModel(model = '') {
  return /^(o\d|gpt-5|.*reasoner.*|.*thinking.*|.*-r1.*)/i.test(model);
}

function normalizeBase(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('缺少 Base URL');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!/\/(v\d+|v\d+beta|openai)$/i.test(u)) u += '/v1';
  return u;
}

async function callOpenAICompat(cfg, messages, timeoutMs) {
  const url = normalizeBase(cfg.baseUrl) + '/chat/completions';
  const reasoning = isReasoningModel(cfg.model);
  const body = { model: cfg.model, messages, stream: false };
  if (reasoning) {
    body.max_completion_tokens = Number(cfg.maxTokens) || 4096;
  } else {
    body.max_tokens = Number(cfg.maxTokens) || 1024;
    body.temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.3;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.extraHeaders || {}),
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} :: ${text.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('返回内容不是合法 JSON：' + text.slice(0, 150)); }
    const msg = data?.choices?.[0]?.message;
    let content = '';
    if (typeof msg?.content === 'string') content = msg.content;
    else if (Array.isArray(msg?.content)) content = msg.content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n');
    else if (typeof data?.output_text === 'string') content = data.output_text;
    return { content: content.trim(), usage: data?.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(cfg, messages, timeoutMs) {
  const url = normalizeBase(cfg.baseUrl) + '/messages';
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  const body = {
    model: cfg.model,
    system,
    messages: rest.length ? rest : [{ role: 'user', content: '请落子' }],
    max_tokens: Number(cfg.maxTokens) || 1024,
  };
  if (!isReasoningModel(cfg.model)) {
    body.temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.3;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        ...(cfg.extraHeaders || {}),
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} :: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    let content = '';
    if (Array.isArray(data?.content)) content = data.content.map((x) => (x?.type === 'text' ? x.text : '')).join('\n');
    else if (typeof data?.content === 'string') content = data.content;
    return { content: content.trim(), usage: data?.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(cfg, prompt, timeoutMs) {
  const messages = [
    { role: 'system', content: '你是一个冷静、精确的五子棋高手，只输出规定格式的内容，绝不输出多余解释。' },
    { role: 'user', content: prompt },
  ];
  if (cfg.protocol === 'anthropic') return callAnthropic(cfg, messages, timeoutMs);
  return callOpenAICompat(cfg, messages, timeoutMs);
}

module.exports = {
  SIZE, COLS, DIRS,
  emptyBoard, inBoard, notation, renderBoard, findWinLine, boardFull,
  dirScore, candidates, scoreAt, engineMove, hintMoves,
  buildPrompt, parseMove, illegalReason,
  isReasoningModel, normalizeBase, callModel,
};

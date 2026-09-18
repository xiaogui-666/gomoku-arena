'use strict';
/**
 * 自测脚本：node selftest.js
 * 覆盖：着法解析容错、内置引擎对局、HTTP 接口（含内置引擎与静态页面）
 */

const E = require('./engine');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

/* ---------- 1. 解析容错 ---------- */
console.log('\n[1] 着法解析');
const board = E.emptyBoard();
const cases = [
  ['MOVE: H8', 7, 7],
  ['REASON: 堵住活三\nMOVE: H8', 7, 7],
  ['move=H8', 7, 7],
  ['我选择 H8', 7, 7],
  ['{"row":8,"col":8}', 7, 7],
  ['{"move":"H8"}', 7, 7],
  ['(8,8)', 7, 7],
  ['8H', 7, 7],
  ['MOVE: A1', 0, 0],
  ['MOVE: O15', 14, 14],
  ['落子：J10', 9, 9],
  ['MOVE: 8,8', 7, 7],
];
for (const [text, r, c] of cases) {
  const m = E.parseMove(text, board);
  ok(`解析「${text.replace(/\n/g, ' ⏎ ')}」→ ${E.notation(r, c)}`, !!m && m.row === r && m.col === c, m ? `实际 ${E.notation(m.row, m.col)}（${m.source}）` : '解析为 null');
}

const occupied = E.emptyBoard();
occupied[7][7] = 1;
ok('已占用点不合法 → null（触发重试）', E.parseMove('MOVE: H8', occupied) === null);
ok('越界坐标 → null', E.parseMove('MOVE: Z99', board) === null, JSON.stringify(E.parseMove('MOVE: Z99', board)));
ok('无坐标文本 → null', E.parseMove('我不知道怎么下', board) === null);

/* ---------- 2. 内置引擎 ---------- */
console.log('\n[2] 内置引擎');
const b2 = E.emptyBoard();
// 黑棋 A1 B1 C1 D1 已四连，E1 应必胜
[[0, 0], [0, 1], [0, 2], [0, 3]].forEach(([r, c]) => { b2[r][c] = 1; });
[[5, 5]].forEach(([r, c]) => { b2[r][c] = 2; });
const winMove = E.engineMove(b2, 1);
ok('能找到立刻成五的点 E1', winMove.row === 0 && winMove.col === 4, JSON.stringify(winMove));

const b3 = E.emptyBoard();
[[7, 7], [7, 8], [7, 9], [7, 10]].forEach(([r, c]) => { b3[r][c] = 2; });
b3[0][0] = 1;
const blockMove = E.engineMove(b3, 1);
ok('会堵对手四连（H11 或 H7）', blockMove.row === 7 && (blockMove.col === 11 || blockMove.col === 6), JSON.stringify(blockMove));

const b4 = E.emptyBoard();
b4[0][0] = 1;
ok('开局中心附近有应手', !!E.engineMove(b4, 2));

/* ---------- 3. 引擎自对局（验证终局判定） ---------- */
console.log('\n[3] 引擎自对局');
function selfPlay(noiseA = 0.25, noiseB = 0.25) {
  const bd = E.emptyBoard();
  const hist = [];
  let turn = 1;
  for (let i = 0; i < 225; i++) {
    const mv = E.engineMove(bd, turn, { noise: turn === 1 ? noiseA : noiseB });
    if (!mv) break;
    bd[mv.row][mv.col] = turn;
    hist.push(`${turn === 1 ? 'X' : 'O'}:${E.notation(mv.row, mv.col)}`);
    const line = E.findWinLine(bd, mv.row, mv.col);
    if (line) return { winner: turn, moves: hist.length, line: line.length };
    if (E.boardFull(bd)) return { winner: 'draw', moves: hist.length };
    turn = turn === 1 ? 2 : 1;
  }
  return { winner: null, moves: hist.length };
}
let decided = 0;
for (let i = 0; i < 5; i++) {
  const r = selfPlay();
  if (r.winner) decided++;
}
ok('5 局自对局均分出胜负/和棋', decided === 5);
const sample = selfPlay(0.1, 0.5);
console.log(`     示例：${sample.winner === 'draw' ? '和棋' : `执${sample.winner === 1 ? '黑' : '白'}胜`}，共 ${sample.moves} 手`);

/* ---------- 4. Prompt ---------- */
console.log('\n[4] Prompt 构造');
const p = E.buildPrompt({ board: b2, me: 1, history: ['X:A1', 'O:F6'], hint: ['E1', 'F1'], withReason: true });
ok('包含棋盘 ASCII', p.includes('A B C D E F G H') && p.includes('X'));
ok('包含坐标说明', p.includes('列用字母 A-O'));
ok('包含候选点', p.includes('E1'));
ok('包含输出格式示例', p.includes('MOVE: H8'));
const pNoReason = E.buildPrompt({ board: b2, me: 2, withReason: false });
ok('关闭理由时不出现 REASON', !pNoReason.includes('REASON'));

/* ---------- 5. HTTP ---------- */
console.log('\n[5] HTTP 接口');
(async () => {
  const { spawn } = require('child_process');
  const PORT = 5199;
  const child = spawn(process.execPath, [__dirname + '/server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 700));
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const health = await (await fetch(base + '/api/health')).json();
    ok('/api/health', health.ok === true);

    const idx = await fetch(base + '/');
    const html = await idx.text();
    ok('首页可访问且含棋盘', idx.status === 200 && html.includes('id="board"'));

    const css = await fetch(base + '/styles.css');
    ok('样式可访问', css.status === 200);

    const mv = await (await fetch(base + '/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cfg: { protocol: 'local' }, board: E.emptyBoard(), me: 1, history: [], opts: {} }),
    })).json();
    ok('/api/move 内置引擎返回合法手', mv.ok === true && mv.notation === 'H8', JSON.stringify(mv.notation));

    const noKey = await (await fetch(base + '/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cfg: { protocol: 'openai', model: 'x' }, board: E.emptyBoard(), me: 1 }),
    })).json();
    ok('缺 Key 时返回明确错误', noKey.ok === false && /API Key/.test(noKey.error));

    /* ---------- 6. mock 上游大模型：代理链路 / 重试 / 兜底 ---------- */
    console.log('\n[6] 模型代理链路（mock 上游）');
    const http = require('http');
    const MOCK_PORT = 5299;
    let mode = 'normal';
    let hits = 0;
    let lastPrompt = null;

    const mock = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        hits++;
        try { lastPrompt = JSON.parse(raw || '{}'); } catch { lastPrompt = null; }
        if (mode === '401') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        let content = 'MOVE: H8';
        if (mode === 'normal') content = 'REASON: 抢占中心要点\nMOVE: H8';
        else if (mode === 'retry') content = hits === 1 ? 'MOVE: H8' : 'MOVE: A1';
        else if (mode === 'garbage') content = '我想了很久，这盘棋非常复杂，我决定不下。';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 123 } }));
      });
    });
    await new Promise((r) => mock.listen(MOCK_PORT, r));

    const cfg = { protocol: 'openai', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'test-key', model: 'mock-model' };
    const post = (payload) => fetch(base + '/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json());

    const r1 = await post({ cfg, board: E.emptyBoard(), me: 1, history: [], opts: { useHint: true } });
    ok('正常返回 → 解析出 H8', r1.ok && r1.notation === 'H8' && r1.source === 'model', JSON.stringify(r1.notation));
    ok('提取到 REASON', r1.reason === '抢占中心要点', r1.reason);
    ok('prompt 含棋盘与坐标规则', !!lastPrompt && /A B C D/.test(lastPrompt.messages[1].content) && /列用字母 A-O/.test(lastPrompt.messages[1].content));
    ok('prompt 含候选点提示', !!lastPrompt && /候选点/.test(lastPrompt.messages[1].content));

    const occupiedB = E.emptyBoard();
    occupiedB[7][7] = 1;
    hits = 0; mode = 'retry';
    const r2 = await post({ cfg, board: occupiedB, me: 2, history: [], opts: {} });
    ok('非法落点 → 自动重试后成功', r2.ok && r2.notation === 'A1' && r2.meta.attempts.length === 2, JSON.stringify(r2.notation));

    hits = 0; mode = 'garbage';
    const r3 = await post({ cfg, board: E.emptyBoard(), me: 1, history: [], opts: {} });
    ok('一直无合法输出 → 引擎兜底且给出告警', r3.ok && r3.source === 'fallback' && /兜底/.test(r3.warn || ''), r3.warn);

    hits = 0; mode = '401';
    const r4 = await post({ cfg, board: E.emptyBoard(), me: 1, history: [], opts: {} });
    ok('上游鉴权失败 → 明确报错且不重试', r4.ok === false && /401/.test(r4.error), r4.error);

    mock.close();
  } catch (e) {
    fail++; console.log('  ✗ HTTP 测试异常：' + e.message);
  } finally {
    child.kill();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();

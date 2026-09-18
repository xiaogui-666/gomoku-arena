'use strict';
/* 端到端：jsdom 加载页面 → 模拟点击 → 跑完整局（内置引擎 vs 内置引擎） */
const { JSDOM } = require('jsdom');
const { spawn } = require('child_process');
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + e)); };

(async () => {
  const child = spawn(process.execPath, [__dirname + '/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(600);

  const dom = await JSDOM.fromFile(__dirname + '/public/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    url: BASE + '/',
    beforeParse(window) {
      window.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : BASE + u, o);
      const stub = new Proxy({}, { get: () => () => stub });
      window.HTMLCanvasElement.prototype.getContext = () => stub;
      window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 240, height: 240, right: 240, bottom: 240 });
      Object.defineProperty(window.Element.prototype, 'clientWidth', { get: () => 600, configurable: true });
    },
  });
  const w = dom.window, d = w.document;
  await sleep(900);

  ok('页面标题正确', d.title.includes('Gomoku Arena'));
  ok('预设供应商已渲染', d.querySelectorAll('#providerList .provider').length >= 10);
  ok('模型下拉已填充', d.querySelectorAll('#pvePreset option').length >= 10);
  ok('默认选中内置引擎', d.getElementById('pvePreset').value === 'local');
  ok('服务状态检测通过', /正常|未连接/.test(d.getElementById('health').textContent));

  // --- 模型对战：内置引擎 vs 内置引擎 ---
  d.getElementById('pvpDelay').value = '0';
  d.getElementById('btnStartPvp').click();
  for (let i = 0; i < 60 && !d.getElementById('boardOverlay').classList.contains('show'); i++) await sleep(500);
  const shown = d.getElementById('boardOverlay').classList.contains('show');
  ok('对战跑完并显示结算', shown, d.getElementById('metaInfo').textContent);
  const title = d.getElementById('overlayTitle').textContent;
  ok('结算标题含获胜方', /获胜|平局/.test(title), title);
  const logs = d.querySelectorAll('#log .log-item').length;
  ok('日志记录了每一手', logs > 20, '条数 ' + logs);
  console.log('     结算：' + title + ' / ' + d.getElementById('overlayDesc').textContent + '，日志 ' + logs + ' 条');

  // --- 人机对战：模拟点击落子 ---
  d.getElementById('overlaySecondary').click();
  d.getElementById('pveStrength').value = '100';
  d.querySelector('#segHumanColor .seg-btn').click(); // 执黑
  d.getElementById('btnStartPve').click();
  await sleep(400);
  const canvas = d.getElementById('board');
  const fire = (x, y) => {
    const ev = new w.MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true });
    canvas.dispatchEvent(ev);
  };
  const cell = (240 - 32) / 14;
  for (let n = 0; n < 6; n++) {
    const r = 7 + n, c = 7;
    const x = 16 + c * cell, y = 16 + r * cell;
    fire(x, y); fire(x, y);            // 两步确认
    await sleep(400);
  }
  const moves = d.querySelectorAll('#log .log-item').length;
  ok('人机模式可落子并触发 AI 回应', moves > 8, '日志 ' + moves);
  ok('回合提示已更新', d.getElementById('turnText').textContent.length > 0, d.getElementById('turnText').textContent);

  // --- 三局两胜：强引擎 vs 弱引擎 ---
  const segs = d.querySelectorAll('#segSeries .seg-btn');
  segs[1].click();                                  // 三局两胜
  d.getElementById('pvpStrength').value = '100';
  d.getElementById('btnStartPvp').click();
  for (let i = 0; i < 160; i++) {
    await sleep(400);
    if (d.getElementById('overlayTitle').textContent.includes('系列赛')) break;
  }
  const t3 = d.getElementById('overlayTitle').textContent;
  const d3 = d.getElementById('overlayDesc').textContent;
  ok('三局两胜跑完并给出系列赛结果', /系列赛|打平/.test(t3), t3);
  const scoreA = Number(d.getElementById('scoreA').textContent);
  const scoreB = Number(d.getElementById('scoreB').textContent);
  const games = [...d.querySelectorAll('#log .log-item')].filter((e) => /局结束/.test(e.textContent)).length;
  ok('打满 3 局或某方先赢 2 局', games === 3 || scoreA === 2 || scoreB === 2, `局数 ${games}，比分 ${scoreA}:${scoreB}`);
  console.log('     系列赛：' + t3 + ' / ' + d3 + '，比分 ' + scoreA + ':' + scoreB);

  dom.window.close();
  child.kill();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})();

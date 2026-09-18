'use strict';
/**
 * Gomoku Arena —— 五子棋 AI 模型在线评测平台（本地服务）
 *
 * 零依赖：仅 Node 内置模块 + 全局 fetch（Node 18+ 即可运行）。
 *   node server.js        然后浏览器打开 http://localhost:5173
 *   PORT=8080 node server.js   自定义端口
 *
 * 作用：
 *   1. 静态托管 public/
 *   2. /api/move  代理各家大模型 API（OpenAI 兼容 / Anthropic / 内置引擎），
 *      顺带解决浏览器直连的 CORS 与协议差异问题
 *   3. /api/test  测试模型连通性
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const PORT = Number(process.env.PORT) || 5173;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- /api/move ---------------- */

async function handleMove(req, res) {
  let payload;
  try { payload = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }

  const cfg = payload.cfg || {};
  const opts = payload.opts || {};
  const board = Array.isArray(payload.board) && payload.board.length === E.SIZE ? payload.board : E.emptyBoard();
  const me = payload.me === 2 ? 2 : 1;
  const history = Array.isArray(payload.history) ? payload.history : [];
  const timeoutMs = Math.max(10, Math.min(300, Number(opts.timeout) || 90)) * 1000;
  const withReason = opts.withReason !== false;
  const useHint = !!opts.useHint;
  const maxRetry = opts.retry === false ? 0 : 1;

  const meta = { attempts: [], fallback: false, latencyMs: 0 };
  const t0 = Date.now();

  // 内置本地引擎（离线可用 / 兜底）
  if (cfg.protocol === 'local') {
    const mv = E.engineMove(board, me, { noise: Number(cfg.noise) || 0 });
    if (!mv) return sendJSON(res, 200, { ok: false, error: '棋盘已满' });
    meta.latencyMs = Date.now() - t0;
    return sendJSON(res, 200, {
      ok: true,
      move: { row: mv.row, col: mv.col },
      notation: E.notation(mv.row, mv.col),
      raw: `内置引擎评分 ${Math.round(mv.score)}`,
      source: 'engine',
      meta,
    });
  }

  if (!cfg.apiKey) return sendJSON(res, 400, { ok: false, error: '缺少 API Key' });
  if (!cfg.model) return sendJSON(res, 400, { ok: false, error: '缺少模型名称' });

  let lastError = null;
  let illegalNote = null;
  let fatal = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const hint = useHint ? E.hintMoves(board, me, 5) : null;
    const prompt = E.buildPrompt({ board, me, history, hint, withReason, illegalNote });
    let out;
    try {
      out = await E.callModel(cfg, prompt, timeoutMs);
    } catch (e) {
      lastError = e.name === 'AbortError' ? `请求超时（${timeoutMs / 1000}s）` : e.message;
      meta.attempts.push({ attempt, error: lastError });
      // 鉴权、参数、模型名等 4xx 错误重试也没用，直接判定为致命错误
      if (/^HTTP 4\d\d/.test(lastError) && !/429|408|409/.test(lastError)) fatal = lastError;
      continue;
    }

    const parsed = E.parseMove(out.content, board);
    meta.attempts.push({
      attempt,
      output: out.content.slice(0, 600),
      usage: out.usage,
      parsed: parsed ? E.notation(parsed.row, parsed.col) : null,
    });

    if (parsed) {
      meta.latencyMs = Date.now() - t0;
      const reason = /REASON\s*[:：]\s*(.+)/i.exec(out.content);
      return sendJSON(res, 200, {
        ok: true,
        move: { row: parsed.row, col: parsed.col },
        notation: E.notation(parsed.row, parsed.col),
        reason: reason ? reason[1].trim().slice(0, 80) : '',
        raw: out.content.slice(0, 800),
        usage: out.usage,
        source: 'model',
        meta,
      });
    }

    illegalNote = E.illegalReason(out.content, board);
    lastError = `模型输出无法解析为合法落点（${illegalNote}）`;
  }

  // 请求层面的错误（网络/超时/鉴权）：明确报错，不要拿兜底掩盖问题
  const allRequestErrors = meta.attempts.length > 0 && meta.attempts.every((a) => a.error);
  if (fatal || allRequestErrors) {
    meta.latencyMs = Date.now() - t0;
    return sendJSON(res, 200, { ok: false, error: fatal || lastError || '模型请求失败', meta });
  }

  // 模型成功返回但输出不可用：由内置引擎替它走一步，保证对局不中断
  const mv = E.engineMove(board, me, {});
  meta.latencyMs = Date.now() - t0;
  meta.fallback = true;
  if (!mv) return sendJSON(res, 200, { ok: false, error: '棋盘已满', meta });
  return sendJSON(res, 200, {
    ok: true,
    move: { row: mv.row, col: mv.col },
    notation: E.notation(mv.row, mv.col),
    reason: '',
    raw: lastError || '',
    source: 'fallback',
    warn: `${lastError || '解析失败'}，已由内置引擎兜底落子`,
    meta,
  });
}

/* ---------------- /api/test ---------------- */

async function handleTest(req, res) {
  let payload;
  try { payload = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  const cfg = payload.cfg || {};
  if (cfg.protocol === 'local') return sendJSON(res, 200, { ok: true, message: '内置引擎可用（无需联网）' });
  if (!cfg.apiKey) return sendJSON(res, 400, { ok: false, error: '缺少 API Key' });
  if (!cfg.model) return sendJSON(res, 400, { ok: false, error: '缺少模型名称' });
  const t0 = Date.now();
  try {
    const out = await E.callModel(cfg, 'Reply with exactly: PONG', 30000);
    return sendJSON(res, 200, { ok: true, latencyMs: Date.now() - t0, preview: (out.content || '').slice(0, 120) });
  } catch (e) {
    return sendJSON(res, 200, { ok: false, error: e.name === 'AbortError' ? '请求超时（30s）' : e.message });
  }
}

/* ---------------- 静态资源 ---------------- */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

if (require.main === module) {
  http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && pathname === '/api/move') return handleMove(req, res);
    if (req.method === 'POST' && pathname === '/api/test') return handleTest(req, res);
    if (pathname === '/api/health') return sendJSON(res, 200, { ok: true, ts: Date.now() });
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    res.writeHead(405); res.end('Method Not Allowed');
  }).listen(PORT, () => {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │   Gomoku Arena · 五子棋 AI 评测台  已启动    │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log(`  本机访问：    http://localhost:${PORT}`);
    console.log(`  局域网/手机： http://<本机内网IP>:${PORT}`);
    console.log('  停止服务：    Ctrl + C');
    console.log('');
  });
}

module.exports = { handleMove, handleTest };

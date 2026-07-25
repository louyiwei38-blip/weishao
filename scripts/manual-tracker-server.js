/**
 * Manual tracker sync server — serve UI + persist state for phone/desktop sync.
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeState,
  defaultState,
  recordTrade,
  resetBankroll,
  undoLastTrade,
  getSummary,
} from '../manual-tracker/lib/bankroll.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'manual-tracker');
const LOGS = join(__dirname, '..', 'logs');
const STATE_FILE = join(LOGS, 'manual-tracker-state.json');
const PORT = Number(process.env.MANUAL_TRACKER_PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function readState() {
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  if (!existsSync(LOGS)) mkdirSync(LOGS, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(normalizeState(state), null, 2), 'utf8');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, relPath) {
  const safe = relPath.replace(/\.\./g, '');
  const filePath = join(ROOT, safe === '/' ? 'index.html' : safe);
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(filePath);
  const data = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(data);
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, readState());
      return;
    }
    if (url.pathname === '/api/summary' && req.method === 'GET') {
      sendJson(res, 200, getSummary(readState()));
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'POST') {
      writeState(await readBody(req));
      sendJson(res, 200, readState());
      return;
    }
    if (url.pathname === '/api/trade' && req.method === 'POST') {
      const body = await readBody(req);
      let state = readState();
      ({ state } = recordTrade(state, Boolean(body.won), { note: body.note, stakeUsd: body.stakeUsd }));
      writeState(state);
      sendJson(res, 200, { state, summary: getSummary(state) });
      return;
    }
    if (url.pathname === '/api/undo' && req.method === 'POST') {
      const state = undoLastTrade(readState());
      writeState(state);
      sendJson(res, 200, { state, summary: getSummary(state) });
      return;
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      const body = await readBody(req);
      const bal = Number(body.balance);
      if (!Number.isFinite(bal) || bal < 0) {
        sendJson(res, 400, { error: 'invalid balance' });
        return;
      }
      const prev = readState();
      writeState(resetBankroll(bal, { settings: prev.settings }));
      sendJson(res, 200, { state: readState(), summary: getSummary(readState()) });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'unknown api' });
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    serveStatic(res, rel);
  } catch (err) {
    sendJson(res, 500, { error: err?.message || 'server error' });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Manual tracker: http://0.0.0.0:${PORT}`);
  console.log(`State file: ${STATE_FILE}`);
});

#!/usr/bin/env node
'use strict';

// ============================================================================
// Nulls Headless Client — Web Console (single-file server)
// ----------------------------------------------------------------------------
// Runs the exact same project as the CLI (`node Program.js ...`) but exposes
// it through an interactive website. No extra dependencies: only Node.js
// built-ins are used.
//
//   PORT=3000 node server.js      # bind port (default 3000)
//   HOST=0.0.0.0 node server.js   # bind address (default 0.0.0.0)
//   WEB_TOKEN=secret node server.js  # optional auth token for the web UI
//
// Every action in the UI is translated into the same CLI command you would
// type in the terminal and executed as a subprocess with `--json`, so the
// behaviour is identical to running the client from a shell.
// ============================================================================

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const VERSION = (() => {
  try {
    return require('./package.json').version;
  } catch {
    return '0.0.0';
  }
})();
// SERVER_PORT is what most game-server panels (Pterodactyl/Wispbyte) inject.
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_TOKEN = process.env.WEB_TOKEN || '';

const CONFIG_PATH = path.join(ROOT, 'config.json');
const FLEET_STATUS = path.join(ROOT, 'fleet-status.json');
const FLEET_PID = path.join(ROOT, 'fleet.pid');
const FLEET_LOG = path.join(ROOT, 'fleet.log');
const ACCOUNTS_DIR = path.join(ROOT, 'accounts');

// Game locales (account language in the game) offered by the console.
// `ar` (Arabic) was added as an extra language on top of the originals.
const GAME_LOCALES = [
  { label: 'العربية (Arabic)', locale: 'ar-SA', preferredLanguage: 'ar' },
  { label: 'English', locale: 'en-US', preferredLanguage: 'en' },
  { label: 'Русский', locale: 'ru-RU', preferredLanguage: 'ru' },
  { label: 'Türkçe', locale: 'tr-TR', preferredLanguage: 'tr' },
  { label: '中文', locale: 'zh-CN', preferredLanguage: 'zh' },
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function sendJSON(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/html; charset=utf-8' });
  res.end(body);
}

// Splits a command line into argv tokens, honouring single & double quotes.
function tokenize(line) {
  const out = [];
  let current = '';
  let quoting = null;
  let inToken = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoting) {
      if (ch === quoting) {
        quoting = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoting = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) out.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quoting) current += quoting;
  if (inToken || current.length) out.push(current);
  return out;
}

function lastJSON(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // grab the last {...} block if the process printed extra lines
  const start = trimmed.lastIndexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Runs `node <script> <args>` capturing stdout/stderr with a hard timeout.
function runNode(script, args, options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeout || 90000);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script].concat(args || []), {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err.message, code: 1, stdout, stderr, timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function summarizeRun(r, command) {
  const parsedStdout = lastJSON(r.stdout);
  const parsedStderr = lastJSON(r.stderr);
  const result = parsedStdout || parsedStderr || null;
  return {
    ok: !r.error && !r.timedOut && !result ? true : !r.error && !r.timedOut && r.code === 0,
    command,
    code: r.code == null ? null : r.code,
    timedOut: !!r.timedOut,
    error: r.error || null,
    stdout: r.stdout,
    stderr: r.stderr,
    result,
  };
}

async function runProgram(args, options) {
  const argv = args.slice();
  if (!argv.some((a) => a === '--json')) argv.push('--json');
  const r = await runNode(path.join(ROOT, 'Program.js'), argv, options);
  return summarizeRun(r, ['node', 'Program.js'].concat(argv).join(' '));
}

async function runTool(bin, args, options) {
  const r = await runNode(path.join(ROOT, 'tools', bin), args, options);
  return summarizeRun(r, ['node', 'tools/' + bin].concat(args).join(' '));
}

// ---------------------------------------------------------------------------
// free-proxy pool backend (tools/proxy-watch.js)
// ---------------------------------------------------------------------------

function poolEntries(file) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, file || 'working-proxies.json'), 'utf8'));
    const items = Array.isArray(data) ? data : data.proxies;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function proxyPoolInfo() {
  const entries = poolEntries('working-proxies.json');
  let checkedAt = null;
  try {
    checkedAt = JSON.parse(fs.readFileSync(path.join(ROOT, 'working-proxies.json'), 'utf8')).checkedAt || null;
  } catch {}
  return { poolCount: entries.length, poolCheckedAt: checkedAt, poolValid: entries.length };
}

async function proxyPoolStatus() {
  const r = await runNode(path.join(ROOT, 'tools', 'proxy-watch.js'), ['status'], { timeout: 8000 });
  const parsed = lastJSON(r.stdout) || {};
  return { ok: true, running: !!parsed.running, state: parsed, ...proxyPoolInfo() };
}

function proxyArgs(body, { interval = false } = {}) {
  const args = [
    '--output',
    String(body.file || 'working-proxies.json'),
    '--limit',
    String(Math.max(1, Math.min(1000, Number(body.limit) || 240))),
    '--parallel',
    String(Math.max(1, Math.min(32, Number(body.parallel) || 6))),
  ];
  if (interval) args.push('--interval', String(Math.max(60, Number(body.interval) || 600)));
  return args;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function authorize(req) {
  if (!WEB_TOKEN) return true;
  const header = req.headers.authorization || '';
  const cookie = req.headers.cookie || '';
  if (header === 'Bearer ' + WEB_TOKEN) return true;
  if (cookie.indexOf('nullsweb_token=' + WEB_TOKEN) !== -1) return true;
  return false;
}

// ---------------------------------------------------------------------------
// request body / routing
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({ parseError: true });
      }
    });
    req.on('error', () => resolve({}));
  });
}

function stateSnapshot() {
  const config = readJSON(CONFIG_PATH, {});
  const fleetStatus = readJSON(FLEET_STATUS, null);
  let pid = null;
  try {
    if (fs.existsSync(FLEET_PID)) pid = Number(String(fs.readFileSync(FLEET_PID, 'utf8')).trim());
  } catch {
    /* ignore */
  }
  let accountFiles = [];
  try {
    accountFiles = fs
      .readdirSync(ACCOUNTS_DIR)
      .filter((name) => name.endsWith('.json') && name !== 'index.json')
      .sort();
  } catch {
    /* ignore */
  }
  let logTail = '';
  try {
    if (fs.existsSync(FLEET_LOG)) {
      const size = fs.statSync(FLEET_LOG).size;
      const read = Math.min(size, 64 * 1024);
      const fd = fs.openSync(FLEET_LOG, 'r');
      const buf = Buffer.alloc(read);
      fs.readSync(fd, buf, 0, read, size - read);
      fs.closeSync(fd);
      logTail = buf.toString('utf8');
    }
  } catch {
    /* ignore */
  }
  return {
    version: VERSION,
    host: config.host || null,
    port: config.port || null,
    binary: config.appBinaryVersion || null,
    cryptoMode: config.cryptoMode || null,
    loginLayout: config.loginLayout || null,
    locale: config.locale || null,
    preferredLanguage: config.preferredLanguage || null,
    uiLanguage: config.uiLanguage ?? 'auto',
    languages: GAME_LOCALES,
    auth: !!WEB_TOKEN,
    accountFiles,
    accountsDirExists: fs.existsSync(ACCOUNTS_DIR),
    fleet: fleetStatus ? { ...fleetStatus, pid } : { pid, running: false, missing: true },
    fleetRunning: !!pid,
    fleetLogTail: logTail.split('\n').filter(Boolean).slice(-200),
  };
}

function router(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (process.env.LOG_REQUESTS) console.log(new Date().toISOString(), req.method, p);

  if (req.method === 'GET' && p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && p === '/favicon.ico') return sendText(res, 204, '', 'text/plain');
  if (req.method === 'GET' && (p === '/health' || p === '/api/health'))
    return sendJSON(res, 200, { ok: true, version: VERSION, port: PORT, auth: !!WEB_TOKEN });

  if (!authorize(req)) return sendJSON(res, 401, { ok: false, error: 'Unauthorized' });

  if (req.method === 'GET' && p === '/api/state') return sendJSON(res, 200, { ok: true, state: stateSnapshot() });
  if (req.method === 'GET' && p === '/api/config') {
    return sendJSON(res, 200, { ok: true, config: readJSON(CONFIG_PATH, {}), languages: GAME_LOCALES });
  }
  if (req.method === 'GET' && p === '/api/logs') {
    const lines = Number(url.searchParams.get('lines') || 200);
    const state = stateSnapshot();
    return sendJSON(res, 200, { ok: true, lines: state.fleetLogTail.slice(-Math.max(1, Math.min(2000, lines))) });
  }

  if (req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        let argv;
        if (Array.isArray(body.args)) argv = body.args.map(String);
        else if (typeof body.args === 'string') argv = tokenize(body.args);
        else argv = [];
        const timeout = body.timeout ? Number(body.timeout) : undefined;

        if (p === '/api/cli') {
          const out = await runProgram(argv, { timeout });
          return sendJSON(res, out.ok ? 200 : 400, out);
        }
        if (p === '/api/accounts') {
          const out = await runTool('accounts.js', argv, { timeout });
          return sendJSON(res, out.ok ? 200 : 400, out);
        }
        if (p === '/api/fleet') {
          // Пул прокси мог не наполниться: без записей не подставляем --proxy-pool-file,
          // иначе клиент упадёт на чтении файла и флот молча умрёт.
          const poolIdx = argv.indexOf('--proxy-pool-file');
          if (poolIdx !== -1) {
            const poolInfo = poolEntries(argv[poolIdx + 1]);
            if (!poolInfo.length) argv = argv.slice(0, poolIdx).concat(argv.slice(poolIdx + 2));
          }
          const out = await runTool('fleet.js', argv, { timeout });
          return sendJSON(res, out.ok ? 200 : 400, out);
        }
        if (p === '/api/connect') {
          const out = await runTool('connect.js', argv, { timeout });
          return sendJSON(res, out.ok ? 200 : 400, out);
        }
        if (p === '/api/watch') {
          const out = await runProgram(['watch', '--once', '--json'], { timeout: timeout || 30000 });
          return sendJSON(res, out.ok ? 200 : 400, out);
        }
        if (p === '/api/proxies') {
          const action = String(body.action || 'status');
          if (action === 'status') return sendJSON(res, 200, await proxyPoolStatus());
          const waiter =
            action === 'once'
              ? runNode(path.join(ROOT, 'tools', 'proxy-watch.js'), ['once', ...proxyArgs(body)], { timeout: 180000 })
              : action === 'start'
                ? runNode(
                    path.join(ROOT, 'tools', 'proxy-watch.js'),
                    ['start', ...proxyArgs(body, { interval: true })],
                    {
                      timeout: 15000,
                    },
                  )
                : action === 'refresh' || action === 'stop'
                  ? runNode(path.join(ROOT, 'tools', 'proxy-watch.js'), [action], { timeout: 10000 })
                  : null;
          if (!waiter) return sendJSON(res, 400, { ok: false, error: 'Unknown proxy action: ' + action });
          const r = await waiter;
          return sendJSON(res, r.code === 0 ? 200 : 400, {
            ok: r.code === 0,
            action,
            run: { code: r.code, error: r.error, stderr: (r.stderr || '').slice(-2000) },
            ...(await proxyPoolStatus()),
          });
        }
        if (p === '/api/config') {
          if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
            return sendJSON(res, 400, { ok: false, error: 'config object required' });
          }
          const current = readJSON(CONFIG_PATH, {});
          const merged = { ...current, ...body.config };
          writeJSON(CONFIG_PATH, merged);
          return sendJSON(res, 200, { ok: true, config: merged, languages: GAME_LOCALES });
        }
        return sendJSON(res, 404, { ok: false, error: 'Not found', path: p });
      } catch (err) {
        return sendJSON(res, 500, { ok: false, error: err.message });
      }
    });
    return;
  }

  return sendJSON(res, 404, { ok: false, error: 'Not found' });
}

const server = http.createServer(router);

server.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const auth = WEB_TOKEN ? ' (auth required)' : '';
  console.log('');
  console.log('  Nulls Headless Client — Web Console');
  console.log(`  version ${VERSION} · port ${PORT} · bind ${HOST}${auth}`);
  console.log(`  open http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT}/`);
  console.log('');
});

// ---------------------------------------------------------------------------
// The web UI (single page embedded inline)
// ---------------------------------------------------------------------------

// String.raw keeps the embedded client script verbatim: a normal template
// literal would turn escapes such as `\n` inside the JS into real newlines
// and the inline script would fail to parse in the browser.
const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nulls Headless Client — Web Console</title>
<style>
  :root {
    --bg: #0d1117;
    --bg2: #161b22;
    --bg3: #1c2128;
    --border: #2d333b;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #4ade80;
    --accent2: #22d3ee;
    --danger: #f87171;
    --warn: #fbbf24;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background:
      radial-gradient(1200px 500px at 85% -10%, rgba(34, 211, 238, 0.08), transparent 60%),
      radial-gradient(900px 500px at -10% 0%, rgba(74, 222, 128, 0.07), transparent 55%),
      var(--bg);
    color: var(--text); font-size: 14px;
  }
  .app { display: flex; min-height: 100vh; }
  .sidebar {
    width: 230px; flex: 0 0 230px; background: var(--bg2); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh;
  }
  .brand { padding: 20px 18px 14px; border-bottom: 1px solid var(--border); }
  .brand h1 { margin: 0; font-size: 17px; letter-spacing: -0.2px; }
  .brand h1 b { color: var(--accent); }
  .brand .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
  nav { padding: 10px 0; flex: 1; overflow-y: auto; }
  nav button {
    display: block; width: 100%; text-align: left; padding: 10px 18px; border: 0; background: none;
    color: var(--muted); font-size: 14px; cursor: pointer; border-left: 3px solid transparent;
  }
  nav button:hover { color: var(--text); background: var(--bg3); }
  nav button.active { color: var(--text); background: var(--bg3); border-left-color: var(--accent); font-weight: 600; }
  .sidefoot { padding: 12px 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; line-height: 1.6; }
  .sidefoot b { color: var(--text); }
  .content { flex: 1; padding: 22px 26px 40px; max-width: 1180px; }
  section.tab { display: none; }
  section.tab.active { display: block; }
  h2 { margin: 0 0 6px; font-size: 21px; }
  .subtitle { color: var(--muted); margin: 0 0 18px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .card .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; }
  .card .v { font-size: 18px; font-weight: 700; margin-top: 5px; word-break: break-word; }
  .card .v.small { font-size: 14px; }
  .panel { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
  .panel h3 { margin: 0 0 12px; font-size: 15px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 12px; color: var(--muted); }
  .field input, .field select, .field textarea {
    background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 8px;
    padding: 8px 10px; font-size: 14px; min-width: 0;
  }
  .field textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  button {
    background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 8px;
    padding: 8px 14px; font-size: 14px; cursor: pointer;
  }
  button { transition: border-color 0.15s, box-shadow 0.15s, filter 0.15s, transform 0.05s; }
  button:hover { border-color: var(--accent); }
  button:active { transform: translateY(1px); }
  button.primary {
    background: linear-gradient(135deg, var(--accent) 0%, #34d399 100%);
    color: #052e16; border-color: transparent; font-weight: 700;
    box-shadow: 0 2px 14px rgba(74, 222, 128, 0.25);
  }
  button.primary:hover { filter: brightness(1.08); box-shadow: 0 4px 18px rgba(74, 222, 128, 0.35); }
  button.ghost { background: transparent; color: var(--accent2); border-color: rgba(34, 211, 238, 0.4); }
  button.ghost:hover { border-color: var(--accent2); box-shadow: 0 2px 12px rgba(34, 211, 238, 0.2); }
  button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
  button.small { padding: 5px 9px; font-size: 12px; }
  .outbox {
    background: #0a0e13; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow: auto; margin-top: 10px;
  }
  .outbox.err { border-color: #7f1d1d; color: #fecaca; }
  .status { color: var(--muted); font-size: 13px; margin: 8px 0; }
  .status.ok { color: var(--accent); }
  .status.bad { color: var(--danger); }
  .status.warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 600; }
  tr:hover td { background: var(--bg3); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--bg3); border: 1px solid var(--border); }
  .pill.on { border-color: var(--accent); color: var(--accent); }
  .pill.off { border-color: var(--danger); color: var(--danger); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } .sidebar { width: 74px; flex-basis: 74px; } .brand .sub, nav button span { display: none; } nav button { text-align: center; padding: 12px 6px; } }
  .link { color: var(--accent2); text-decoration: none; cursor: pointer; }
  .muted { color: var(--muted); }
  .badge { display: inline-block; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 1px 7px; font-size: 12px; color: var(--muted); }
  .hint { color: var(--muted); font-size: 12px; line-height: 1.55; margin: 9px 0 0; }
  .panel h3 { display: flex; align-items: center; gap: 8px; }
  .panel h3::before {
    content: ''; width: 8px; height: 14px; border-radius: 3px; flex: 0 0 auto;
    background: linear-gradient(180deg, var(--accent), var(--accent2));
  }
  table.bots { width: 100%; border-collapse: collapse; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  table.bots th, table.bots td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  table.bots th { color: var(--muted); font-weight: 600; }
  .st { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: var(--bg3); border: 1px solid var(--border); }
  .st.online { border-color: var(--accent); color: var(--accent); }
  .st.queued, .st.connecting, .st.pending { border-color: var(--accent2); color: var(--accent2); }
  .st.failed, .st.blocked, .st.error { border-color: var(--danger); color: var(--danger); }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); cursor: pointer; }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <h1>Nulls <b>Web</b></h1>
      <div class="sub">Headless Client console</div>
    </div>
    <nav id="nav">
      <button data-tab="dashboard" class="active"><span>Dashboard</span></button>
      <button data-tab="terminal"><span>Terminal</span></button>
      <button data-tab="accounts"><span>Accounts</span></button>
      <button data-tab="fleet"><span>Fleet</span></button>
      <button data-tab="proxy"><span>Proxies</span></button>
      <button data-tab="social"><span>Club &amp; Friends</span></button>
      <button data-tab="lobby"><span>Lobby &amp; Battle</span></button>
      <button data-tab="config"><span>Config</span></button>
    </nav>
    <div class="sidefoot">
      <div>version: <b id="v-version">-</b></div>
      <div>server: <b id="v-host">-</b></div>
      <div>binary: <b id="v-binary">-</b></div>
      <div id="v-auth" class="muted"></div>
    </div>
  </aside>
  <main class="content">

    <section id="tab-dashboard" class="tab active">
      <h2>Dashboard</h2>
      <p class="subtitle">Live status of the client, the account registry and the bot fleet.</p>
      <div class="cards" id="dash-cards"></div>
      <div class="panel">
        <h3>Fleet status <span class="badge" id="dash-fleet-badge">-</span></h3>
        <div id="dash-fleet" class="outbox">loading…</div>
      </div>
      <div class="panel">
        <h3>fleet.log tail</h3>
        <div id="dash-log" class="outbox">loading…</div>
      </div>
    </section>

    <section id="tab-terminal" class="tab">
      <h2>Terminal</h2>
      <p class="subtitle">Type any CLI command exactly as in the terminal — it runs on this server via <code>node Program.js … --json</code>.</p>
      <div class="panel">
        <div class="row">
          <div class="field" style="flex:1">
            <label>Command <span class="muted">(no leading <b>node</b>)</span></label>
            <input id="term-input" placeholder="create-account --account accounts/bot-1.json --name MyBot --once" autocomplete="off" spellcheck="false">
          </div>
          <button class="primary" id="term-run">Run</button>
          <button id="term-clear">Clear</button>
        </div>
        <div class="status" id="term-status"></div>
        <div class="outbox" id="term-out">Ready. Run <b>help</b> or <b>info</b> to start.</div>
      </div>
      <div class="panel">
        <h3>Examples</h3>
        <div class="row" id="term-presets"></div>
      </div>
    </section>

    <section id="tab-accounts" class="tab">
      <h2>Accounts</h2>
      <p class="subtitle">Registry, creation and login. <b>Arabic (العربية)</b> is available as the account's game language.</p>
      <div class="grid2">
        <div class="panel">
          <h3>Create account</h3>
          <div class="row">
            <div class="field" style="flex:1"><label>File (accounts/*.json)</label><input id="acc-file" placeholder="bot-5.json"></div>
          </div>
          <div class="row" style="margin-top:10px">
            <div class="field" style="flex:1"><label>Name</label><input id="acc-name" placeholder="MyBot"></div>
            <div class="field"><label>Region (optional)</label><input id="acc-region" placeholder="KZ" style="width:110px"></div>
          </div>
          <div class="row" style="margin-top:10px">
            <div class="field" style="flex:1"><label>Game language</label><select id="acc-locale"></select></div>
          </div>
          <div class="row" style="margin-top:10px"><button class="primary" id="acc-create">Create account</button></div>
        </div>
        <div class="panel">
          <h3>Manage</h3>
          <div class="row">
            <div class="field" style="flex:1"><label>Account key (file, index, tag or name)</label><input id="acc-key" placeholder="bot-1.json"></div>
          </div>
          <div class="row" style="margin-top:10px">
            <button class="primary" id="acc-login">Login (--once)</button>
            <button id="acc-info">Info</button>
            <button id="acc-show">Show (registry)</button>
          </div>
          <div class="row" style="margin-top:10px">
            <button id="acc-refresh">Refresh registry</button>
            <button id="acc-stats">Stats</button>
            <button id="acc-prune">Prune (dry-run)</button>
            <button id="acc-cleanup">Cleanup .runtime</button>
          </div>
        </div>
      </div>
      <div class="panel">
        <h3>Region</h3>
        <div class="row">
          <div class="field" style="flex:1"><label>Account</label><input id="reg-account" placeholder="bot-1.json"></div>
          <div class="field"><label>Region</label><input id="reg-code" placeholder="US | KZ | 125 | 14:249" style="width:220px"></div>
          <button class="primary" id="reg-save">Set region</button>
        </div>
      </div>
      <div class="panel">
        <h3>Registry <button class="small" id="acc-list-again" style="float:right">reload</button></h3>
        <div class="outbox" id="acc-list">loading…</div>
      </div>
    </section>

    <section id="tab-fleet" class="tab">
      <h2>Fleet</h2>
      <p class="subtitle">Background bot fleet. Same commands as <code>node tools/fleet.js …</code>.</p>
      <div class="panel">
        <h3 id="fleet-status-title">Fleet status</h3>
        <div id="fleet-status" class="outbox">loading…</div>
      </div>
      <div class="grid2">
        <div class="panel">
          <h3>Start fleet</h3>
          <div class="row">
            <div class="field"><label>From #</label><input id="fleet-first" value="1" style="width:64px"></div>
            <div class="field"><label>Bots</label><input id="fleet-count" value="3" style="width:64px"></div>
            <div class="field"><label>Parallel</label><input id="fleet-concurrency" value="5" style="width:64px"></div>
            <div class="field" style="flex:1"><label>Name prefix</label><input id="fleet-prefix" placeholder="Bot"></div>
          </div>
          <div class="row">
            <div class="field" style="flex:1"><label>Club tag to auto-join after login</label><input id="fleet-clubtag" placeholder="#TAG"></div>
          </div>
          <div class="row" style="margin-top:10px"><button class="primary" id="fleet-start">Launch bots</button></div>
          <p class="hint">Each bot logs in (and joins the club) in background. Failed first logins are retried automatically. Start again with a higher count to add more bots.</p>
        </div>
        <div class="panel">
          <h3>Quick actions</h3>
          <div class="row">
            <div class="field" style="flex:1"><label>Club tag</label><input id="fleet-qclub" placeholder="#TAG"></div>
          </div>
          <div class="row" style="margin-top:8px">
            <button class="ghost" id="fleet-join-all">Join club → all bots</button>
            <button class="ghost" id="fleet-leave-all">Leave club → all bots</button>
          </div>
          <div class="row" style="margin-top:10px">
            <button id="fleet-retry">Retry</button>
            <button id="fleet-pause">Pause</button>
            <button id="fleet-resume">Resume</button>
            <button id="fleet-stop">Stop</button>
            <button id="fleet-status-btn">Status</button>
          </div>
          <p class="hint">Retry replays all failed/blocked bots. The club field also pre-fills “Start fleet”.</p>
        </div>
      </div>
      <div class="panel">
        <h3>Command a bot</h3>
        <div class="row">
          <div class="field"><label>Bot (ignored when All)</label><input id="fleet-bot" value="1" style="width:60px"></div>
          <div class="field" style="flex:1"><label>Action</label><select id="fleet-action"></select></div>
          <div class="field" style="flex:1"><label>Extra args</label><input id="fleet-extra" placeholder="e.g. --club-tag #TAG --text Hello"></div>
          <button class="primary" id="fleet-cmd">Send</button>
        </div>
        <div class="muted" id="fleet-action-hint" style="margin-top:6px;font-size:12px"></div>
        <div class="row" style="margin-top:8px">
          <label class="check"><input type="checkbox" id="fleet-all"> All bots — send to every bot (for bulk club/logins)</label>
        </div>
      </div>
      <div class="panel">
        <h3>Bots</h3>
        <div id="fleet-bots" class="outbox">no fleet status yet — start a fleet first</div>
      </div>
    </section>

    <section id="tab-proxy" class="tab">
      <h2>Proxies — free IP rotation</h2>
      <p class="subtitle">Fetches free SOCKS5/HTTP proxies from public lists, verifies each one against the game server, and routes fleet logins through different IPs to dodge IP-based rate / throttle limits.</p>
      <div class="grid2">
        <div class="panel">
          <h3>Proxy pool</h3>
          <div class="row">
            <div class="field" style="flex:1"><label>Pool file</label><input id="px-file" value="working-proxies.json"></div>
            <div class="field"><label>Limit</label><input id="px-limit" value="240" style="width:62px"></div>
            <div class="field"><label>Parallel</label><input id="px-parallel" value="6" style="width:58px"></div>
            <div class="field"><label>Refresh (s)</label><input id="px-interval" value="600" style="width:62px"></div>
          </div>
          <div class="row" style="margin-top:10px">
            <button class="primary" id="px-start">Start watcher</button>
            <button class="ghost" id="px-once">Fetch once</button>
            <button id="px-refresh">Refresh now</button>
            <button id="px-stop">Stop</button>
          </div>
          <p class="hint">Start watcher keeps the pool fresh in the background. Fetch once runs a single batch and exits — best right before a big bot launch. Each entry is verified with a real ClientHello through the proxy before it is added to the pool.</p>
        </div>
        <div class="panel">
          <h3>Use for the fleet</h3>
          <div class="row">
            <label class="check"><input type="checkbox" id="px-use"> Use the pool for fleet logins (IP rotation per bot)</label>
          </div>
          <p class="hint">When enabled, Launch bots adds <code>--proxy-pool-file</code> so every bot (and every reconnect) rotates to a different working proxy. Empty pool → bots fall back to your direct IP automatically, so the fleet never silently dies.</p>
        </div>
      </div>
      <div class="panel">
        <h3>Status</h3>
        <div id="px-status" class="outbox">Loading…</div>
      </div>
    </section>

    <section id="tab-social" class="tab">
      <h2>Club &amp; Friends</h2>
      <p class="subtitle">Club membership, chat, requests and friends. These connect with the selected account.</p>
      <div class="panel">
        <div class="row">
          <div class="field" style="flex:1"><label>Account</label><input id="soc-account" placeholder="bot-1.json"></div>
          <button class="small" id="soc-account-latest">use last</button>
        </div>
      </div>
      <div id="soc-forms"></div>
    </section>

    <section id="tab-lobby" class="tab">
      <h2>Lobby &amp; Battle</h2>
      <p class="subtitle">Lobby rooms, chat, matchmaking, spectate and Brawl TV.</p>
      <div class="panel">
        <div class="row">
          <div class="field" style="flex:1"><label>Account</label><input id="lob-account" placeholder="bot-1.json"></div>
          <button class="small" id="lob-account-latest">use last</button>
        </div>
      </div>
      <div id="lob-forms"></div>
    </section>

    <section id="tab-config" class="tab">
      <h2>Config</h2>
      <p class="subtitle">Server/connection settings from <code>config.json</code>. The <b>locale</b>/<b>preferredLanguage</b> values are sent by the login handshake — Arabic is available.</p>
      <div class="panel">
        <h3>config.json</h3>
        <div class="field"><label>Raw JSON (edit, then Save)</label><textarea id="cfg-json" rows="22" spellcheck="false"></textarea></div>
        <div class="row" style="margin-top:10px">
          <button class="primary" id="cfg-save">Save config</button>
          <button id="cfg-lang-ar" class="primary">Set game language to Arabic (العربية)</button>
          <button id="cfg-reload">Reload</button>
        </div>
        <div class="status" id="cfg-status"></div>
      </div>
      <div class="panel">
        <h3>Interface language</h3>
        <div class="row">
          <select id="cfg-ui-lang"></select>
          <button id="cfg-ui-save">Change UI language</button>
        </div>
        <div class="status muted" style="margin-top:8px">Runs <code>node Program.js lang &lt;code&gt;</code> on the server (ru / en / tr / zh / ar).</div>
      </div>
    </section>

  </main>
</div>

<script>
(function () {
  'use strict';

  var account = '';
  try { account = localStorage.getItem('nullsweb.account') || ''; } catch (e) { account = ''; }
  var uiLang = '';
  try { uiLang = localStorage.getItem('nullsweb.uilang') || ''; } catch (e) { uiLang = ''; }
  var token = '';
  try { token = localStorage.getItem('nullsweb.token') || ''; } catch (e) { token = ''; }

  var STATE = { config: null, state: null };

  function api(method, url, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { promptToken(); return { ok: false, unauthorized: true }; }
        return j;
      });
    });
  }

  function promptToken() {
    var t = window.prompt('This console requires WEB_TOKEN. Enter it:');
    if (t) { token = t; try { localStorage.setItem('nullsweb.token', t); } catch (e) {} window.location.reload(); }
  }

  function setAccount(file) {
    account = file;
    try { localStorage.setItem('nullsweb.account', file); } catch (e) {}
    var inputs = document.querySelectorAll('#soc-account, #lob-account, #acc-key, #reg-account, #acc-file');
    for (var i = 0; i < inputs.length; i++) { if (!inputs[i].value) inputs[i].value = file; }
  }

  function $(id) { return document.getElementById(id); }
  function qsAll(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pretty(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }

  function outBox(el, text, isErr) {
    el.textContent = text == null ? '' : text;
    el.className = 'outbox' + (isErr ? ' err' : '');
  }
  function statusEl(el, text, kind) {
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Accepts a bare name ("bot-1"), a filename ("bot-1.json") or a path
  // ("accounts/bot-1.json") and always returns a repo-relative path.
  function normalizeAccountKey(key) {
    key = (key || '').trim();
    if (!key) return '';
    if (key.indexOf('.json') === -1) key += '.json';
    if (key.indexOf('/') === -1) key = 'accounts/' + key;
    return key;
  }

  // ------------------------- tabs -------------------------
  var navBtns = qsAll('#nav button');
  function showTab(name) {
    navBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    qsAll('section.tab').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
    if (name === 'dashboard') refreshState();
    if (name === 'fleet') refreshFleet();
    if (name === 'accounts') refreshRegistry();
    if (name === 'config') loadConfig();
  }
  navBtns.forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });

  // ------------------------- dashboard -------------------------
  function refreshState() {
    api('GET', '/api/state').then(function (j) {
      if (!j.ok || !j.state) return;
      STATE.state = j.state;
      var s = j.state;
      $('v-version').textContent = s.version;
      $('v-host').textContent = (s.host || '-') + ':' + (s.port || '-');
      $('v-binary').textContent = s.binary || '-';
      $('v-auth').textContent = s.auth ? 'auth required (WEB_TOKEN)' : 'open access';

      var cards = '';
      cards += card('Server', s.host || '-', '');
      cards += card('Port', String(s.port || '-'), '');
      cards += card('Binary', s.binary || '-', '');
      cards += card('Crypto', s.cryptoMode || '-', 'small');
      cards += card('Login layout', s.loginLayout || '-', 'small');
      cards += card('Account files', String(s.accountFiles ? s.accountFiles.length : 0), '');
      cards += card('Fleet', s.fleetRunning ? 'running' : 'stopped', 'small');
      cards += card('Interface lang', s.uiLanguage || 'auto', 'small');
      $('dash-cards').innerHTML = cards;

      var f = s.fleet || {};
      $('dash-fleet-badge').textContent = s.fleetRunning ? 'running (PID ' + (f.pid || '?') + ')' : 'stopped';
      $('dash-fleet-badge').className = 'badge ' + (s.fleetRunning ? 'pill on' : 'pill off');
      $('dash-fleet').textContent = pretty(f);
      $('dash-log').textContent = s.fleetLogTail.slice(-80).join('\n') || '(empty)';

      // (re)fill the account-language selector now that the locale list is known
      var sel = $('acc-locale');
      if (sel) sel.innerHTML = localeOptions(sel.value);
    }).catch(function (e) { $('dash-fleet').textContent = 'error: ' + e.message; });
  }
  function card(k, v, cls) {
    return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v ' + cls + '">' + esc(v) + '</div></div>';
  }

  // ------------------------- terminal -------------------------
  function termRun() {
    var line = $('term-input').value.trim();
    if (!line) return;
    var status = $('term-status');
    statusEl(status, 'running ' + line + ' …', 'warn');
    var args = line;
    api('POST', '/api/cli', { args: args, timeout: 90000 }).then(function (j) {
      if (j.ok === false && j.unauthorized) { statusEl(status, 'unauthorized', 'bad'); return; }
      status.textContent = 'exit code: ' + j.code + (j.timedOut ? ' (timeout)' : '');
      status.className = 'status ' + (j.ok ? 'ok' : 'bad');
      var text = '$ node Program.js ' + line + ' --json\n';
      if (j.error) text += 'ERROR: ' + j.error + '\n';
      if (j.stdout && j.stdout.trim()) text += j.stdout.trim();
      if (j.stderr && j.stderr.trim()) text += (text ? '\n--- stderr ---\n' : '') + j.stderr.trim();
      outBox($('term-out'), text, !j.ok);
    }).catch(function (e) {
      statusEl(status, e.message, 'bad');
      outBox($('term-out'), e.message, true);
    });
  }
  $('term-run').addEventListener('click', termRun);
  $('term-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') termRun(); });
  $('term-clear').addEventListener('click', function () { outBox($('term-out'), ''); $('term-status').textContent = ''; });

  var PRESETS = [
    ['help', 'help'],
    ['info', 'info'],
    ['lang (Arabic)', 'lang ar'],
    ['regions', 'regions'],
    ['modes', 'modes'],
    ['features', 'features'],
    ['dry-run create', 'create-account --account accounts/demo.json --name Demo --dry-run']
  ];
  var presetsBox = $('term-presets');
  PRESETS.forEach(function (p) {
    var b = document.createElement('button');
    b.className = 'small';
    b.textContent = p[0];
    b.addEventListener('click', function () { $('term-input').value = p[1]; termRun(); });
    presetsBox.appendChild(b);
  });

  // ------------------------- accounts -------------------------
  function localeOptions(selected) {
    var fs = STATE.state && STATE.state.languages ? STATE.state.languages : [];
    var html = '';
    for (var i = 0; i < fs.length; i++) {
      var sel = fs[i].locale === selected ? ' selected' : '';
      html += '<option value="' + esc(fs[i].locale) + '" data-pref="' + esc(fs[i].preferredLanguage) + '"' + sel + '>' + esc(fs[i].label) + '</option>';
    }
    return html;
  }
  window.addEventListener('load', function () {
    $('acc-locale').innerHTML = localeOptions('');
    var self = $('acc-locale');
    // make sure Arabic is included (in case state not yet loaded)
    if (self.options.length === 0) $('acc-locale').innerHTML = '<option value="ar-SA" data-pref="ar">العربية (Arabic)</option><option value="en-US" data-pref="en">English</option>';
  });

  function accountArgs(extra) {
    var a = (extra || []).slice();
    if (account) a.push('--account', account);
    return a;
  }

  $('acc-create').addEventListener('click', function () {
    var file = normalizeAccountKey($('acc-file').value.trim() || ('bot-' + Date.now() + '.json'));
    var name = $('acc-name').value.trim();
    if (!name) { statusEl($('acc-list'), 'name is required', 'bad'); return; }
    var sel = $('acc-locale');
    var locale = sel.value;
    var pref = sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].getAttribute('data-pref') : locale;
    var args = ['create-account', '--account', file, '--name', name, '--once'];
    if ($('acc-region').value.trim()) args.push('--region', $('acc-region').value.trim());
    if (locale) args.push('--locale', locale, '--preferred-language', pref || locale);
    setAccount(file);
    statusEl($('acc-list'), 'creating ' + file + ' …', 'warn');
    api('POST', '/api/cli', { args: args, timeout: 90000 }).then(function (j) {
      $('acc-list').textContent = pretty(j);
      $('acc-list').className = 'outbox' + (j.ok ? '' : ' err');
      refreshRegistry();
    });
  });

  $('acc-login').addEventListener('click', function () {
    var key = $('acc-key').value.trim();
    if (!key) { statusEl($('acc-list'), 'enter an account file', 'bad'); return; }
    var file = normalizeAccountKey(key);
    setAccount(file);
    statusEl($('acc-list'), 'logging in …', 'warn');
    api('POST', '/api/cli', { args: ['login', '--account', file, '--once'], timeout: 90000 }).then(function (j) {
      $('acc-list').textContent = pretty(j);
      $('acc-list').className = 'outbox' + (j.ok ? '' : ' err');
      refreshRegistry();
    });
  });

  $('acc-info').addEventListener('click', function () {
    var key = $('acc-key').value.trim();
    if (!key) { return; }
    var file = normalizeAccountKey(key);
    setAccount(file);
    api('POST', '/api/cli', { args: ['account-info', '--account', file], timeout: 30000 }).then(function (j) {
      $('acc-list').textContent = pretty(j);
      $('acc-list').className = 'outbox' + (j.ok ? '' : ' err');
    });
  });

  $('acc-show').addEventListener('click', function () {
    var key = $('acc-key').value.trim();
    if (!key) return;
    api('POST', '/api/accounts', { args: ['show', key] }).then(function (j) {
      $('acc-list').textContent = pretty(j);
      $('acc-list').className = 'outbox' + (j.ok ? '' : ' err');
    });
  });

  function accRunSimple(label, args) {
    statusEl($('acc-list'), label + ' …', 'warn');
    api('POST', '/api/accounts', { args: args }).then(function (j) {
      $('acc-list').textContent = pretty(j);
      $('acc-list').className = 'outbox' + (j.ok ? '' : ' err');
    });
  }
  $('acc-refresh').addEventListener('click', function () { accRunSimple('refresh', ['refresh']); });
  $('acc-stats').addEventListener('click', function () { accRunSimple('stats', ['stats']); });
  $('acc-prune').addEventListener('click', function () { accRunSimple('prune (dry-run)', ['prune', '--dry-run']); });
  $('acc-cleanup').addEventListener('click', function () { accRunSimple('cleanup', ['cleanup']); });
  $('acc-list-again').addEventListener('click', function () { refreshRegistry(); });

  $('reg-save').addEventListener('click', function () {
    var acc = $('reg-account').value.trim();
    var code = $('reg-code').value.trim();
    if (!acc || !code) { statusEl($('acc-list'), 'both account and region are required', 'bad'); return; }
    var file = normalizeAccountKey(acc);
    setAccount(file);
    statusEl($('acc-list'), 'setting region …', 'warn');
    api('POST', '/api/cli', { args: ['account-region', '--account', file, '--region', code, '--once'], timeout: 90000 }).then(function (j) {
      $('acc-list').textContent = pretty(j);
      $('acc-list').className = 'outbox' + (j.ok ? '' : ' err');
    });
  });

  function refreshRegistry() {
    $('acc-list').textContent = 'loading…';
    api('POST', '/api/accounts', { args: ['list', '--json'] }).then(function (j) {
      var text = j.result ? pretty(j.result) : pretty(j);
      $('acc-list').textContent = text;
      $('acc-list').className = 'outbox' + (j.ok ? '' : ' err');
      if (j.result && j.result.accounts && j.result.accounts.length) {
        var first = j.result.accounts[0].file;
        if (!account) setAccount('accounts/' + first);
      }
    });
  }

  // ------------------------- fleet -------------------------
  var FLEET_ACTIONS = ['login', 'create-account', 'account-region', 'friend', 'accept-friend', 'decline-friend', 'remove-friend', 'friends', 'friends-online', 'spectate', 'brawl-tv-channels', 'brawl-tv-next', 'brawl-tv', 'stop-spectate', 'create-club', 'join-club', 'leave-club', 'club-info', 'club-recommendations', 'club-members', 'club-online', 'club-chat', 'club-stream', 'club-requests', 'club-settings', 'club-description', 'club-trophies', 'club-role', 'club-promote', 'club-demote', 'club-kick', 'club-invite', 'club-request', 'club-answer', 'create-room', 'join-room', 'leave-room', 'team-info', 'chat', 'ready', 'unready', 'matchmake', 'cancel-matchmake', 'team-mode', 'team-map', 'team-event', 'team-location', 'team-invite', 'team-answer', 'invite-answer', 'accept-invite', 'decline-invite', 'team-request', 'team-cancel-request', 'team-request-answer', 'team-cancel-invite', 'team-kick', 'team-advertise', 'team-status', 'invitations', 'team-brawler', 'team-bot', 'practice', 'player-status', 'top'];
  var ACTION_HINTS = {
    'account-region': '--region <code> (eu / us / ru / asia…)',
    'friend': '--tag #PLAYER_TAG',
    'accept-friend': '--tag #PLAYER_TAG',
    'decline-friend': '--tag #PLAYER_TAG',
    'remove-friend': '--tag #PLAYER_TAG',
    'spectate': '--tag #PLAYER_TAG',
    'brawl-tv': '--experimental',
    'brawl-tv-channels': '--experimental',
    'brawl-tv-next': '--experimental',
    'create-club': '--club-name "Club Name"',
    'join-club': '--club-tag #TAG',
    'club-info': '--club-tag #TAG (omit — your own club)',
    'club-members': '--club-tag #TAG (omit — your own club)',
    'club-online': '--club-tag #TAG (omit — your own club)',
    'club-chat': '--text "hello"',
    'club-settings': '--description "…" --type 1|2|3 --required-trophies 0',
    'club-description': '--description "text"',
    'club-trophies': '--required-trophies N',
    'club-role': '--tag #MEMBER --role <role>',
    'club-promote': '--tag #MEMBER',
    'club-demote': '--tag #MEMBER',
    'club-kick': '--tag #MEMBER [--text reason]',
    'club-invite': '--tag #PLAYER_TAG --experimental',
    'club-request': '--club-tag #TAG --text "reason"',
    'club-answer': '--tag #MEMBER --accept true|false',
    'create-room': '--type 0|1 [--once]',
    'join-room': '--code ROOM_CODE [--once]',
    'chat': '--text "hello"',
    'team-mode': '--mode <mode id>',
    'team-map': '--map <map name>',
    'team-event': '--event <id> [--slot N]',
    'team-location': '--location <value>',
    'team-invite': '--tag #PLAYER_TAG',
    'team-answer': '--accept true|false --experimental',
    'invite-answer': '--accept true|false [--code]',
    'accept-invite': '[--code ROOM_CODE]',
    'decline-invite': '[--code ROOM_CODE]',
    'team-request': '--tag #PLAYER_TAG',
    'team-request-answer': '--tag #PLAYER --accept true|false',
    'team-cancel-invite': '--tag #PLAYER_TAG',
    'team-kick': '--tag #PLAYER_TAG',
    'team-advertise': '--experimental',
    'team-status': '--status <value>',
    'team-brawler': '--brawler <index> --experimental',
    'team-bot': '--slot 0-9 --disabled true|false',
    'practice': '--experimental',
    'player-status': '--tag #PLAYER_TAG --experimental',
    top: '--type 0|1'
  };
  var fleetActionSel = $('fleet-action');
  FLEET_ACTIONS.forEach(function (a) {
    var o = document.createElement('option');
    o.value = a; o.textContent = a;
    fleetActionSel.appendChild(o);
  });
  function updateFleetHint() {
    var h = ACTION_HINTS[$('fleet-action').value];
    $('fleet-action-hint').textContent = h ? 'Parameters: ' + h : 'No extra parameters needed.';
  }
  fleetActionSel.addEventListener('change', updateFleetHint);
  updateFleetHint();

  function fleetRun(args, label) {
    $('fleet-status').textContent = label + ' …';
    $('fleet-status').className = 'outbox';
    api('POST', '/api/fleet', { args: args, timeout: 120000 }).then(function (j) {
      $('fleet-status').textContent = pretty(j);
      $('fleet-status').className = 'outbox' + (j.ok ? '' : ' err');
      refreshFleet();
    });
  }

  $('fleet-status-btn').addEventListener('click', function () { fleetRun(['status'], 'status'); });
  $('fleet-stop').addEventListener('click', function () { fleetRun(['stop'], 'stop'); });
  $('fleet-pause').addEventListener('click', function () { fleetRun(['pause'], 'pause'); });
  $('fleet-resume').addEventListener('click', function () { fleetRun(['resume'], 'resume'); });
  $('fleet-retry').addEventListener('click', function () { fleetRun(['retry'], 'retry'); });
  // Two club-tag fields (start + quick actions) stay in sync.
  function syncClub(fromId, toId) {
    var el = $(fromId), other = $(toId);
    el.addEventListener('input', function () { other.value = el.value; });
  }
  syncClub('fleet-clubtag', 'fleet-qclub');
  syncClub('fleet-qclub', 'fleet-clubtag');

  $('fleet-start').addEventListener('click', function () {
    var args = ['start', '--first', $('fleet-first').value || '1', '--count', $('fleet-count').value || '3'];
    var par = parseInt($('fleet-concurrency').value, 10);
    if (par >= 1 && par <= 20) args.push('--concurrency', String(par));
    if ($('fleet-prefix').value.trim()) args.push('--name-prefix', $('fleet-prefix').value.trim());
    var club = $('fleet-clubtag').value.trim();
    if (club) args.push('--club-tag', club);
    if ($('px-use') && $('px-use').checked)
      args.push('--proxy-pool-file', $('px-file').value.trim() || 'working-proxies.json');
    fleetRun(args, 'start');
  });
  $('fleet-join-all').addEventListener('click', function () {
    var tag = $('fleet-qclub').value.trim();
    if (!tag) { $('fleet-status').textContent = 'Enter a club tag first (e.g. #ABC …).'; $('fleet-status').className = 'outbox err'; return; }
    fleetRun(['command', '--all', '--action', 'join-club', '--club-tag', tag], 'join-club (all bots)');
  });
  $('fleet-leave-all').addEventListener('click', function () {
    fleetRun(['command', '--all', '--action', 'leave-club'], 'leave-club (all bots)');
  });

  // ------------------------- proxies (free IP rotation) -------------------------
  var PX_KEY = 'nullsweb.px';
  function loadProxyPrefs() {
    try {
      var d = JSON.parse(localStorage.getItem(PX_KEY) || '{}');
      $('px-use').checked = !!d.use;
      if (d.file) $('px-file').value = d.file;
      if (d.limit) $('px-limit').value = d.limit;
      if (d.parallel) $('px-parallel').value = d.parallel;
      if (d.interval) $('px-interval').value = d.interval;
    } catch (e) {}
  }
  function saveProxyPrefs() {
    try {
      localStorage.setItem(PX_KEY, JSON.stringify({
        use: $('px-use').checked,
        file: $('px-file').value.trim() || 'working-proxies.json',
        limit: $('px-limit').value || '240',
        parallel: $('px-parallel').value || '6',
        interval: $('px-interval').value || '600'
      }));
    } catch (e) {}
  }
  loadProxyPrefs();
  ['px-use', 'px-file', 'px-limit', 'px-parallel', 'px-interval'].forEach(function (id) {
    $(id).addEventListener('change', saveProxyPrefs);
  });
  function renderProxyStatus(j) {
    var lines = [];
    lines.push((j.running ? 'watcher: RUNNING' : 'watcher: stopped') +
      (j.poolCount ? (' | pool: ' + j.poolCount + ' working proxies' + (j.poolCheckedAt ? ' (checked ' + j.poolCheckedAt + ')' : '')) : ' | pool: empty — fetch once or start the watcher'));
    if (j.state && j.state.busy) lines.push('checking proxies right now…');
    if (j.state && j.state.error) lines.push('last error: ' + j.state.error);
    if (j.state && j.state.sourceResults) {
      lines.push('sources: ' + j.state.sourceResults.map(function (s) { return s.name + '=' + (s.error ? 'ERR' : (s.entries + ' raw')); }).join(' '));
    }
    $('px-status').textContent = lines.join('\n');
    $('px-status').className = 'outbox' + (j.running ? '' : ' err');
  }
  function proxyAction(action) {
    saveProxyPrefs();
    if (action === 'once') {
      $('px-status').textContent = 'Fetching proxies… checking each one against the server (can take up to a minute).';
      $('px-status').className = 'outbox';
    }
    api('POST', '/api/proxies', {
      action: action,
      file: $('px-file').value.trim() || 'working-proxies.json',
      limit: $('px-limit').value || '240',
      parallel: $('px-parallel').value || '6',
      interval: $('px-interval').value || '600'
    }).then(function (j) {
      if (j.ok) renderProxyStatus(j);
      else {
        $('px-status').textContent = ((j.run && j.run.stderr) || j.error || ('proxy action failed: ' + action)).slice(-400);
        $('px-status').className = 'outbox err';
      }
    });
  }
  $('px-start').addEventListener('click', function () { proxyAction('start'); });
  $('px-once').addEventListener('click', function () { proxyAction('once'); });
  $('px-refresh').addEventListener('click', function () { proxyAction('refresh'); });
  $('px-stop').addEventListener('click', function () { proxyAction('stop'); });
  proxyAction('status');
  $('fleet-cmd').addEventListener('click', function () {
    var action = $('fleet-action').value;
    var extra = tokenizeLine($('fleet-extra').value);
    var args = ['command'];
    if ($('fleet-all').checked) args.push('--all');
    else args.push('--bot', $('fleet-bot').value || '1');
    args.push('--action', action);
    fleetRun(args.concat(extra), 'command ' + action + ($('fleet-all').checked ? ' (all bots)' : ''));
  });

  // splits a command line into tokens, honouring single/double quotes
  function tokenizeLine(line) {
    var out = [], cur = '', quoting = null, inToken = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (quoting) {
        if (ch === quoting) quoting = null; else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quoting = ch; inToken = true; continue; }
      if (ch === ' ' || ch === '\t') { if (inToken) out.push(cur); cur = ''; inToken = false; continue; }
      cur += ch; inToken = true;
    }
    if (inToken) out.push(cur);
    return out;
  }

  function refreshFleet() {
    api('POST', '/api/fleet', { args: ['status'], timeout: 15000 }).then(function (j) {
      $('fleet-status').textContent = pretty(j.result || j);
      $('fleet-status').className = 'outbox' + (j.ok ? '' : ' err');
      $('fleet-status-title').textContent = j.result && j.result.running ? 'Fleet status — running' : 'Fleet status — stopped';
      renderBots(j.result);
    });
  }

  // one row per bot so you can watch many accounts at once
  function renderBots(status) {
    var box = $('fleet-bots');
    if (!status || !status.bots || !status.bots.length) {
      box.className = 'outbox';
      box.textContent = status && status.bots && !status.bots.length ? 'no bots in fleet yet' : 'no fleet status yet — start a fleet first';
      return;
    }
    var counts = { online: 0, ok: 0, failed: 0, queued: 0 };
    status.bots.forEach(function (b) {
      if (['online', 'battle', 'in-battle', 'spectating'].includes(b.status)) counts.online++;
      if (b.status === 'failed' || b.status === 'blocked') counts.failed++;
      if (b.status === 'queued' || b.status === 'connecting' || b.status === 'joining-club') counts.queued++;
    });
    var summary =
      '<div class="row" style="margin-bottom:8px;gap:6px">' +
      '<span class="badge">total ' + status.bots.length + '</span>' +
      '<span class="pill on">online ' + counts.online + '</span>' +
      '<span class="pill">pending ' + counts.queued + '</span>' +
      '<span class="pill off">failed ' + counts.failed + '</span>' +
      '</div>';
    var rows = status.bots.map(function (b) {
      var ind = b.index;
      var name = b.name || '-';
      var tag = b.tag || '-';
      var club = (b.club && b.club.tag) ? b.club.tag : (b.joined ? 'joined' : '-');
      var err = b.clubError ? ' (club: ' + b.clubError + ')' : '';
      var info = esc(err || b.error || '') + (b.attempts > 1 ? ' · ' + b.attempts + ' tries' : '');
      return '<tr>' +
        '<td>#' + ind + '</td>' +
        '<td class="st ' + b.status + '">' + b.status + '</td>' +
        '<td>' + esc(name) + '</td>' +
        '<td>' + esc(tag) + '</td>' +
        '<td>' + esc(club) + '</td>' +
        '<td class="muted">' + esc(info) + '</td>' +
        '</tr>';
    }).join('');
    box.className = 'outbox bots';
    box.innerHTML = summary +
      '<table class="bots"><thead><tr><th>#</th><th>status</th><th>name</th><th>tag</th><th>club</th><th>info</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ------------------------- social & lobby forms -------------------------
  function simpleForm(container, title, fields, build, accountInputId) {
    var p = document.createElement('div');
    p.className = 'panel';
    var h = document.createElement('h3');
    h.textContent = title;
    p.appendChild(h);
    var row = document.createElement('div');
    row.className = 'row';
    var inputs = {};
    fields.forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.className = 'field';
      var lbl = document.createElement('label');
      lbl.textContent = f.label;
      var input = document.createElement(f.type === 'select' ? 'select' : 'input');
      input.className = 'inp f-' + f.id;
      if (f.type === 'select' && f.options) {
        f.options.forEach(function (o) {
          var op = document.createElement('option');
          op.value = o; op.textContent = o;
          input.appendChild(op);
        });
      }
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.style) input.style.cssText = f.style;
      wrap.appendChild(lbl);
      wrap.appendChild(input);
      row.appendChild(wrap);
      inputs[f.id] = input;
    });
    p.appendChild(row);
    var out = document.createElement('div');
    out.className = 'outbox';
    out.style.display = 'none';
    var status = document.createElement('div');
    status.className = 'status';
    var btnRow = document.createElement('div');
    btnRow.className = 'row';
    btnRow.style.marginTop = '10px';
    var btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Run';
    btn.addEventListener('click', function () {
      var args = build(inputs);
      var accInput = $(accountInputId || 'soc-account');
      var accVal = (accInput && accInput.value.trim()) || account || 'account.json';
      args.splice(1, 0, '--account', accVal);
      status.textContent = 'running …';
      status.className = 'status warn';
      status.style.display = '';
      out.style.display = '';
      api('POST', '/api/cli', { args: args, timeout: 90000 }).then(function (j) {
        status.textContent = 'exit: ' + j.code;
        status.className = 'status ' + (j.ok ? 'ok' : 'bad');
        var text = '';
        if (j.stdout && j.stdout.trim()) text += j.stdout.trim();
        if (j.stderr && j.stderr.trim()) text += (text ? '\n--- stderr ---\n' : '') + j.stderr.trim();
        out.textContent = text;
        out.className = 'outbox' + (j.ok ? '' : ' err');
      });
    });
    btnRow.appendChild(btn);
    p.appendChild(btnRow);
    p.appendChild(status);
    p.appendChild(out);
    container.appendChild(p);
  }

  (function buildSocialForms() {
    var c = $('soc-forms');
    simpleForm(c, 'Send friend request', [{ id: 'tag', label: 'Player tag' }], function (i) { return ['friend', '--tag', i.tag.value]; });
    simpleForm(c, 'Accept / decline friend request', [
      { id: 'tag', label: 'Player tag' },
      { id: 'accept', label: 'Decision', type: 'select', options: ['accept', 'decline'] }
    ], function (i) { return [i.accept.value === 'accept' ? 'accept-friend' : 'decline-friend', '--tag', i.tag.value]; });
    simpleForm(c, 'Remove friend', [{ id: 'tag', label: 'Player tag' }], function (i) { return ['remove-friend', '--tag', i.tag.value]; });
    simpleForm(c, 'Friends list', [], function () { return ['friends']; });
    simpleForm(c, 'Friends online', [], function () { return ['friends-online']; });
    simpleForm(c, 'Player leaderboard', [
      { id: 'type', label: 'Type', type: 'select', options: ['0', '1'] }
    ], function (i) { var a = ['top']; if (i.type.value !== '0') a.push('--type', i.type.value); return a; });
    simpleForm(c, 'Create club', [{ id: 'name', label: 'Club name' }], function (i) { return ['create-club', '--club-name', i.name.value]; });
    simpleForm(c, 'Join club', [{ id: 'tag', label: 'Club tag (#...)' }], function (i) { return ['join-club', '--club-tag', i.tag.value]; });
    simpleForm(c, 'Leave club', [], function () { return ['leave-club']; });
    simpleForm(c, 'Club info', [{ id: 'tag', label: 'Club tag (empty — your club)' }], function (i) { var a = ['club-info']; if (i.tag.value) a.push('--club-tag', i.tag.value); return a; });
    simpleForm(c, 'Club members', [], function () { return ['club-members']; });
    simpleForm(c, 'Club online', [], function () { return ['club-online']; });
    simpleForm(c, 'Club chat', [{ id: 'text', label: 'Text' }], function (i) { return ['club-chat', '--text', i.text.value]; });
    simpleForm(c, 'Send club request', [
      { id: 'tag', label: 'Club tag' },
      { id: 'text', label: 'Request text' }
    ], function (i) { return ['club-request', '--club-tag', i.tag.value, '--text', i.text.value]; });
    simpleForm(c, 'Answer club request', [
      { id: 'tag', label: 'Member tag' },
      { id: 'accept', label: 'Decision', type: 'select', options: ['accept', 'decline'] }
    ], function (i) { return ['club-answer', '--tag', i.tag.value, '--accept', i.accept.value === 'accept' ? 'true' : 'false']; });
    simpleForm(c, 'Club requests', [], function () { return ['club-requests']; });
    simpleForm(c, 'Club stream', [], function () { return ['club-stream']; });
    simpleForm(c, 'Kick member', [
      { id: 'tag', label: 'Member tag' },
      { id: 'reason', label: 'Reason (optional)' }
    ], function (i) { var a = ['club-kick', '--tag', i.tag.value]; if (i.reason.value) a.push('--text', i.reason.value); return a; });
    simpleForm(c, 'Club settings', [
      { id: 'desc', label: 'Description (optional)' },
      { id: 'type', label: 'Type', type: 'select', options: ['1', '2', '3'] },
      { id: 'trophies', label: 'Required trophies', placeholder: '0' }
    ], function (i) { var a = ['club-settings']; if (i.desc.value) a.push('--description', i.desc.value); a.push('--type', i.type.value); if (i.trophies.value) a.push('--required-trophies', i.trophies.value); return a; });
  })();

  (function buildLobbyForms() {
    var c = $('lob-forms');
    var f = function (title, fields, build) { simpleForm(c, title, fields, build, 'lob-account'); };
    f('Create lobby (single cycle)', [{ id: 'type', label: 'Type', type: 'select', options: ['0', '1'] }], function (i) { return ['create-room', '--type', i.type.value, '--once']; });
    f('Join lobby (single cycle)', [{ id: 'code', label: 'Room code' }], function (i) { return ['join-room', '--code', i.code.value, '--once']; });
    f('Leave lobby', [], function () { return ['leave-room']; });
    f('Lobby state', [], function () { return ['team-info']; });
    f('Lobby chat', [{ id: 'text', label: 'Text' }], function (i) { return ['chat', '--text', i.text.value]; });
    f('Pick mode', [{ id: 'mode', label: 'Mode (e.g. BrawlBall)' }], function (i) { return ['team-mode', '--mode', i.mode.value]; });
    f('Pick map', [{ id: 'map', label: 'Map name' }], function (i) { return ['team-map', '--map', i.map.value]; });
    f('Ready', [], function () { return ['ready']; });
    f('Unready', [], function () { return ['unready']; });
    f('Start matchmaking (single cycle)', [], function () { return ['matchmake', '--once']; });
    f('Cancel matchmaking', [], function () { return ['cancel-matchmake']; });
    f('Invite friend/clubmate', [{ id: 'tag', label: 'Player tag' }], function (i) { return ['team-invite', '--tag', i.tag.value]; });
    f('Accept invitation', [{ id: 'code', label: 'Code (optional)' }], function (i) { var a = ['accept-invite']; if (i.code.value) a.push('--code', i.code.value); return a; });
    f('Decline invitation', [{ id: 'code', label: 'Code (optional)' }], function (i) { var a = ['decline-invite']; if (i.code.value) a.push('--code', i.code.value); return a; });
    f('Incoming invitations', [], function () { return ['invitations']; });
    f('Kick from lobby', [{ id: 'tag', label: 'Player tag' }], function (i) { return ['team-kick', '--tag', i.tag.value]; });
    f('Spectate player', [{ id: 'tag', label: 'Player tag' }], function (i) { return ['spectate', '--tag', i.tag.value, '--once']; });
    f('Brawl TV channels', [], function () { return ['brawl-tv-channels', '--experimental']; });
    f('Brawl TV (first channel)', [], function () { return ['brawl-tv', '--experimental']; });
  })();

  $('soc-account-latest').addEventListener('click', function () { $('soc-account').value = account; });
  $('lob-account-latest').addEventListener('click', function () { $('lob-account').value = account; });

  // ------------------------- config -------------------------
  function loadConfig() {
    api('GET', '/api/config').then(function (j) {
      if (!j.config) return;
      STATE.config = j.config;
      $('cfg-json').value = pretty(j.config);
      $('cfg-status').textContent = 'config.json loaded';
      $('cfg-status').className = 'status ok';
    });
  }
  $('cfg-reload').addEventListener('click', loadConfig);
  $('cfg-save').addEventListener('click', function () {
    var parsed = null;
    try { parsed = JSON.parse($('cfg-json').value); } catch (e) { $('cfg-status').textContent = 'invalid JSON: ' + e.message; $('cfg-status').className = 'status bad'; return; }
    api('POST', '/api/config', { config: parsed }).then(function (j) {
      if (j.ok) { $('cfg-status').textContent = 'config saved'; $('cfg-status').className = 'status ok'; }
      else { $('cfg-status').textContent = j.error || 'error'; $('cfg-status').className = 'status bad'; }
    });
  });
  $('cfg-lang-ar').addEventListener('click', function () {
    try {
      var cfg = JSON.parse($('cfg-json').value);
      cfg.locale = 'ar-SA';
      cfg.preferredLanguage = 'ar';
      $('cfg-json').value = pretty(cfg);
      api('POST', '/api/config', { config: { locale: 'ar-SA', preferredLanguage: 'ar' } }).then(function (j) {
        $('cfg-status').textContent = j.ok ? 'game language set to Arabic; saved to config.json' : (j.error || 'error');
        $('cfg-status').className = 'status ' + (j.ok ? 'ok' : 'bad');
      });
    } catch (e) { $('cfg-status').textContent = 'invalid JSON: ' + e.message; $('cfg-status').className = 'status bad'; }
  });

  var uiSel = $('cfg-ui-lang');
  ['auto', 'ru', 'en', 'tr', 'zh', 'ar'].forEach(function (l) {
    var o = document.createElement('option');
    o.value = l; o.textContent = l + (l === 'ar' ? ' (العربية)' : '');
    if (l === uiLang) o.selected = true;
    uiSel.appendChild(o);
  });
  $('cfg-ui-save').addEventListener('click', function () {
    var l = uiSel.value;
    try { localStorage.setItem('nullsweb.uilang', l); } catch (e) {}
    statusEl($('cfg-status'), 'setting interface language: ' + l + ' …', 'warn');
    api('POST', '/api/cli', { args: ['lang', l], timeout: 30000 }).then(function (j) {
      $('cfg-status').textContent = 'node Program.js lang ' + l + ' -> exit ' + j.code;
      $('cfg-status').className = 'status ' + (j.ok ? 'ok' : 'bad');
    });
  });

  // ------------------------- init -------------------------
  // if a persisted account exists, prefill inputs
  setTimeout(function () {
    if (account) setAccount(account);
    refreshState();
    if (uiLang) uiSel.value = uiLang;
  }, 0);

})();
</script>
</body>
</html>
`;

if (require.main === module) {
  // server already started above
}

module.exports = { server, stateSnapshot, runNode, tokenize, lastJSON, runProgram, runTool, GAME_LOCALES, PORT, HOST };

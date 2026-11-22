#!/usr/bin/env node
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parse } = require('../lib/Args');
const Store = require('../lib/Store');
const Accounts = require('../lib/Accounts');
const Selection = require('../lib/Selection');
const Platform = require('../utils/Platform');
const ROOT = path.resolve(__dirname, '..'),
  PID = path.join(ROOT, 'fleet.pid'),
  LOG = path.join(ROOT, 'fleet.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const LOG_CHECK_INTERVAL = 60000;
const CLEANUP_INTERVAL = 600000;
const CLEANUP_RESULTS_MAX_AGE = 3600000;
const CLEANUP_PROCESSING_MAX_AGE = 600000;
const CLEANUP_STALE_MAX_AGE = 86400000;

function logOptions(options = {}) {
  const maxBytes = Number(options.maxBytes ?? options.logMaxBytes ?? LOG_MAX_BYTES);
  const keep = Number(options.keep ?? options.logKeep ?? LOG_KEEP);
  return {
    maxBytes: Number.isFinite(maxBytes) && maxBytes >= 1024 ? Math.floor(maxBytes) : LOG_MAX_BYTES,
    keep: Number.isInteger(keep) && keep >= 1 && keep <= 20 ? keep : LOG_KEEP,
  };
}

// fleet.log → fleet.log.1 … fleet.log.keep, самый старый удаляется.
// Переименование открытого файла на Windows запрещено, поэтому вызывающие сначала закрывают
// свой дескриптор (FleetLog) либо ротируют до spawn (start). Ошибка переименования не фатальна:
// возвращается false, лог продолжает писаться в тот же файл до следующей попытки.
function rotateLog(file, options = {}) {
  const { maxBytes, keep } = logOptions(options);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size < maxBytes) return false;
  try {
    fs.rmSync(`${file}.${keep}`, { force: true });
  } catch {}
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    return false;
  }
  return true;
}

// Дескриптор лог-файла, который умеет закрыться перед ротацией и открыться заново.
class FleetLog {
  constructor(file, options = {}) {
    this.file = file;
    this.options = logOptions(options);
    this.fd = null;
  }
  open() {
    if (this.fd !== null) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'a', 0o600);
  }
  write(chunk) {
    try {
      this.open();
      fs.writeSync(this.fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    } catch {}
  }
  close() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {}
    this.fd = null;
  }
  rotateIfNeeded() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size < this.options.maxBytes) return false;
    this.close();
    const rotated = rotateLog(this.file, this.options);
    this.open();
    return rotated;
  }
}

// Дублирует stdout/stderr в fleet.log. В `start` дочерний процесс получает stdio 'ignore',
// поэтому единственный писатель в лог — этот tee, и ротация не ломает чужой дескриптор.
function installTee(log) {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      log.write(chunk);
      return original(chunk, encoding, callback);
    };
  }
}

function runCleanup() {
  try {
    const report = Accounts.cleanup(ROOT, {
      resultsMaxAge: CLEANUP_RESULTS_MAX_AGE,
      processingMaxAge: CLEANUP_PROCESSING_MAX_AGE,
      staleMaxAge: CLEANUP_STALE_MAX_AGE,
    });
    if (report.removed) console.log(`очистка .runtime: удалено файлов ${report.removed}`);
    return report;
  } catch (error) {
    console.error(`очистка .runtime: ${error.message}`);
    return null;
  }
}

function ownedPID() {
  const pid = Number(fs.existsSync(PID) ? fs.readFileSync(PID, 'utf8') : 0);
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    if (
      fs.existsSync(`/proc/${pid}/cmdline`) &&
      !fs.readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(__filename))
    )
      return null;
    return pid;
  } catch (error) {
    if (error.code === 'EPERM')
      console.error(`fleet.pid указывает на процесс ${pid}, принадлежащий другому пользователю; уберите файл вручную`);
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Остатки после жёсткого завершения (хост выключили и включили): fleet.pid жив,
// а процесс умер. Если процесс жив и это наш флот — сначала останавливаем его,
// затем убираем fleet.pid и fleet-status.json, чтобы консоль снова разрешила старт.
async function removeStaleFleetState(signal) {
  const pid = ownedPID();
  if (pid && signal) {
    try {
      process.kill(pid, signal);
    } catch {}
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isAlive(pid)) await sleep(200);
    if (isAlive(pid)) {
      // Процесс «завис» и не отвечает на SIGTERM — жёстко завершаем. Это наш флот
      // (подтверждено ownedPID), чужой процесс не тронем.
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
      const killUntil = Date.now() + 3000;
      while (Date.now() < killUntil && isAlive(pid)) await sleep(150);
    }
  }
  const removed = [];
  for (const file of [PID, path.join(ROOT, 'fleet-status.json')]) {
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed.push(path.relative(ROOT, file));
      }
    } catch (error) {
      console.error(`не удалось удалить ${file}: ${error.message}`);
    }
  }
  return { pid, removed };
}

// Индексы существующих accounts/bot-N.json — естественный набор для выбора --bots.
function botIndexes() {
  try {
    return fs
      .readdirSync(path.join(ROOT, 'accounts'))
      .map((name) => /^bot-(\d+)\.json$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
// Все сохранённые аккаунты. Если bot-N.json нет, но есть «именные» файлы (probe.json
// и т.п.), флот усыновляет их первым слотом — считаем минимум один «существующий» индекс.
function accountIndexes() {
  const bots = botIndexes();
  if (bots.length) return bots;
  try {
    const names = fs.readdirSync(path.join(ROOT, 'accounts'));
    if (names.some((n) => n.endsWith('.json') && n !== 'index.json' && !/^bot-\d+\.json$/.test(n))) return [1];
  } catch {}
  return [];
}

// Разворачивает --bots/--select в явный список индексов для запуска флота.
// Если файлов аккаунтов ещё нет, границы берём из самого выражения или --count.
function resolveStartIndexes(options = {}) {
  const spec = options.bots || options.select || options.indexes;
  if (spec == null || spec === '') return null;
  // Для выбора актуальны только bot-N файлы: «именные» аккаунты флот усыновит
  // отдельным слотом, поэтому числовой диапазон раскрываем полностью.
  let available = botIndexes();
  if (!available.length) {
    const numbers = String(spec).match(/\d+/g);
    const max = numbers && numbers.length ? Math.max(...numbers.map(Number)) : Number(options.count) || 1;
    available = Array.from({ length: Math.max(1, max) }, (_, n) => n + 1);
  }
  return Selection.parseSelection(String(spec), available);
}

// Сколько ботов затронет выбор — для оценки дедлайна ожидания результатов команды.
function selectionSize(options = {}, status = {}) {
  const spec = options.bots || options.select;
  if (spec == null || spec === '') return options.all ? Number(status.requested) || 1 : 1;
  const available = Array.isArray(status.bots) && status.bots.length
    ? status.bots.map((bot) => Number(bot.index)).filter(Number.isInteger)
    : accountIndexes();
  let byId = null;
  if (Array.isArray(status.bots)) {
    byId = new Map(status.bots.filter((bot) => bot.id).map((bot) => [bot.id, Number(bot.index)]));
  }
  try {
    return Selection.parseSelection(String(spec), available, byId).length || 1;
  } catch {
    return 1;
  }
}

// Бесплатные прокси из публичных списков: один прогон proxy-watch (once) собирает и
// проверяет пул working-proxies.json, через который флот получает ротацию IP.
function buildFreeProxyPool() {
  const poolFile = 'working-proxies.json';
  return new Promise((resolve) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, poolFile), 'utf8'));
      const proxies = Array.isArray(data) ? data : data.proxies;
      const checkedAt = data && data.checkedAt ? Date.parse(data.checkedAt) : 0;
      if (Array.isArray(proxies) && proxies.length && Date.now() - checkedAt < 10 * 60 * 1000) return resolve(poolFile);
    } catch {}
    console.log('Собираю бесплатные прокси: первый прогон проверки…');
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'tools', 'proxy-watch.js'), 'once', '--output', poolFile, '--limit', '240'],
      { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const done = () => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ROOT, poolFile), 'utf8'));
        const proxies = Array.isArray(data) ? data : data.proxies;
        return resolve(Array.isArray(proxies) && proxies.length ? poolFile : null);
      } catch {
        return resolve(null);
      }
    };
    child.on('close', done);
    child.on('error', done);
  });
}

async function main() {
  const argv = process.argv.slice(2),
    { options, positional } = parse(argv),
    command = positional[0] || 'status';
  if (command === 'status') {
    console.log(
      JSON.stringify({ ...Store.read(path.join(ROOT, 'fleet-status.json'), {}), running: !!ownedPID() }, null, 2),
    );
    return;
  }
  if (command === 'stop') {
    const pid = ownedPID();
    const statusExists = fs.existsSync(path.join(ROOT, 'fleet-status.json'));
    if (pid) {
      process.kill(pid, 'SIGTERM');
      console.log('Остановка запрошена');
    } else if (fs.existsSync(PID) || statusExists) {
      // Процесс мёртв (host перезапускали), а fleet.pid/fleet-status.json остались —
      // консоль показывала ботов «онлайн». Очищаем остатки, чтобы можно было стартовать заново.
      const state = await removeStaleFleetState();
      console.log(
        `Процесс не запущен; устаревшее состояние очищено (${state.removed.join(', ') || 'ничего'}). Запустите fleet снова, чтобы боты вошли повторно.`,
      );
    } else {
      console.log('Процесс не запущен');
    }
    return;
  }
  if (command === 'reset') {
    // Жёсткая перезагрузка флота: останавливает живой процесс (если есть), чистит
    // fleet.pid и fleet-status.json. Боты не удаляются — их токены лежат в accounts/.
    const state = await removeStaleFleetState('SIGTERM');
    const result = { ok: true, ...state, note: 'Боты не удалены; их токены остались в accounts/. Запустите fleet, чтобы войти снова' };
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'start') {
    if (ownedPID()) throw new Error('Процесс уже запущен; используйте status, stop или reset');
    if (options.freeProxies && !options.proxyPoolFile) {
      const pool = await buildFreeProxyPool();
      if (pool) argv.push('--proxy-pool-file', pool);
      else console.error('Рабочих прокси нет — флот стартует без IP-ротации');
    }
    // Ротация до открытия файла: на Windows переименовать занятый файл нельзя.
    rotateLog(LOG, logOptions(options));
    const child = spawn(process.execPath, [__filename, 'run', ...argv.slice(1)], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    console.log(`Запуск PID ${child.pid}. Проверка: node tools/fleet.js status`);
    return;
  }
  if (
    [
      'command',
      'retry-registration',
      'pause',
      'resume',
      'retry',
      'club-fill',
      'club-cancel',
      'club-queue',
      'club-dominate',
      'club-dominate-status',
      'club-dominate-cancel',
    ].includes(command)
  ) {
    if (!ownedPID()) throw new Error('Сначала запустите fleet');
    const action =
      command === 'retry-registration'
        ? 'retry'
        : command === 'command'
          ? options.action
          : command;
    if (!action) throw new Error('Нужен --action');
    const id = crypto.randomUUID();
    const file = path.join(ROOT, '.runtime', 'commands', `${id}.json`);
    const status = Store.read(path.join(ROOT, 'fleet-status.json'), {});
    Store.write(file, {
      bot: options.bot,
      all: options.all,
      select: options.bots || options.select || undefined,
      id: options.id || undefined,
      ids: options.ids ? String(options.ids).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      action,
      args: options,
      queue: !!(options.queue || options.fill) || action === 'club-fill',
    });
    const result = path.join(ROOT, '.runtime', 'results', `${id}.json`);
    // Действие ждёт «первого входа» ботов (login → потом действие), поэтому ориентир:
    // base timeout + волны логинов/действий. Одна волна ≈ 8 ботов командой параллельно.
    // Очередь в клуб и доминация отвечают сразу.
    const instant = ['club-fill', 'club-cancel', 'club-queue', 'club-dominate', 'club-dominate-status', 'club-dominate-cancel'].includes(
      action,
    );
    const requested = instant ? 1 : selectionSize(options, status);
    const deadline =
      Date.now() + Number(options.timeout || 60000) + (requested > 1 ? Math.ceil(requested / 8) * 5000 : 0);
    while (!fs.existsSync(result)) {
      if (Date.now() > deadline || !ownedPID())
        throw new Error(`Результат ещё не получен. ID: ${id}; не повторяйте действие автоматически`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const value = Store.read(result);
    console.log(JSON.stringify(value, null, 2));
    if (!value.ok || (Array.isArray(value.result) && value.result.some((v) => v.error || v.confirmed === false)))
      process.exitCode = 1;
    return;
  }
  if (command !== 'run')
    throw new Error(
      'fleet: start|run|status|stop|command|retry|pause|resume|club-fill|club-cancel|club-queue|club-dominate|club-dominate-status|club-dominate-cancel',
    );
  if (ownedPID()) throw new Error('Процесс уже запущен');
  const log = new FleetLog(LOG, logOptions(options));
  log.rotateIfNeeded();
  installTee(log);
  // --bots/--select разворачиваем в явный список индексов; --indexes может прийти строкой.
  const startIndexes = resolveStartIndexes(options);
  if (startIndexes && startIndexes.length) options.indexes = startIndexes;
  else if (typeof options.indexes === 'string')
    options.indexes = options.indexes.split(',').map(Number).filter(Number.isInteger);
  if (options.nameRandom && typeof options.nameRandom === 'string')
    options.nameRandom = !['false', '0', 'no'].includes(options.nameRandom);
  const Fleet = require('../lib/Fleet');
  const fleet = new Fleet(ROOT, options);
  fs.writeFileSync(PID, String(process.pid), { mode: 0o600 });
  Platform.fileModeSecure(PID);
  const wakeLock = Platform.wakeLock(true);
  const rotateTimer = setInterval(() => log.rotateIfNeeded(), LOG_CHECK_INTERVAL);
  rotateTimer.unref?.();
  runCleanup();
  const cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL);
  cleanupTimer.unref?.();
  const stop = () => {
    clearInterval(rotateTimer);
    clearInterval(cleanupTimer);
    fleet.stop();
    if (fs.existsSync(PID) && Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID);
    if (wakeLock) Platform.wakeLock(false);
    log.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  global.Debugger = Object.fromEntries(
    ['info', 'warn', 'error'].map((k) => [
      k,
      (...args) => console.log(new Date().toISOString(), k.toUpperCase(), ...args),
    ]),
  );
  fleet.start();
}
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { rotateLog, FleetLog, logOptions };

#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { parse } = require('../lib/Args');
const Accounts = require('../lib/Accounts');

const ROOT = path.resolve(__dirname, '..');
// lib/Args.js не знает про эти флаги и без значения упал бы; подставляем явное true.
const FLAGS = new Set(['json', 'registered', 'dry-run', 'all', 'force']);

function parseArgs(argv) {
  return parse(argv.map((item) => (FLAGS.has(item.slice(2)) ? `${item}=true` : item)));
}

function formatTable(entries) {
  const headers = ['ИНДЕКС', 'ТЕГ', 'ID', 'НИК', 'ТОКЕН', 'КЛУБ', 'ФАЙЛ'];
  const rows = entries.map((entry) => [
    entry.index === null ? '-' : String(entry.index),
    entry.tag || '-',
    entry.id || '-',
    entry.name || '-',
    entry.error ? 'БИТЫЙ' : entry.hasToken ? 'да' : 'нет',
    entry.club || '-',
    entry.file,
  ]);
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'list';
  const json = !!options.json;
  // Проставляем ID при каждом обращении: новые/старые account.json получают свой
  // уникальный ID, по которому можно управлять ботом (--id / --account @id / @id).
  Accounts.ensureIds(ROOT);
  if (command === 'list') {
    const registry = Accounts.read(ROOT);
    let entries = registry.accounts;
    if (options.registered) entries = entries.filter((entry) => entry.hasToken && (entry.hi || entry.lo));
    const limit = Number(options.limit ?? 0);
    if (Number.isInteger(limit) && limit > 0) entries = entries.slice(0, limit);
    if (json)
      console.log(
        JSON.stringify({ version: registry.version, updatedAt: registry.updatedAt, accounts: entries }, null, 2),
      );
    else if (!entries.length) console.log('Аккаунтов нет: accounts/ пуст или отсутствует');
    else console.log(formatTable(entries));
    return;
  }
  if (command === 'show') {
    const entry = Accounts.find(ROOT, positional[1]);
    if (!entry) {
      console.error('Аккаунт не найден; укажите индекс, тег или точный ник');
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ...entry, path: path.join(Accounts.accountsDir(ROOT), entry.file) }, null, 2));
    return;
  }
  if (command === 'refresh') {
    const registry = Accounts.refresh(ROOT);
    console.log(
      JSON.stringify(
        { updatedAt: registry.updatedAt, accounts: registry.accounts.length, path: Accounts.registryPath(ROOT) },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'prune') {
    const report = Accounts.prune(ROOT, { dryRun: !!options.dryRun });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'stats') {
    console.log(JSON.stringify(Accounts.stats(ROOT), null, 2));
    return;
  }
  if (command === 'cleanup') {
    const report = Accounts.cleanup(ROOT);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'reset') {
    if (String(options.force) !== 'true') {
      console.error('Осторожно: reset удаляет ВСЕ аккаунты и рантайм-состояние (accounts/, fleet.pid, fleet-status.json, .runtime/, логи, кэш прокси). Повторите с --force.');
      process.exitCode = 1;
      return;
    }
    const report = resetRuntime(ROOT);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  throw new Error('accounts: list|show|refresh|prune|stats|cleanup|reset');
}

// Внутренний «сброс на чистый клон»: убираем только игнорируемые git-ом артефакты
// (аккаунты, состояние флота, рантайм, логи, кэш прокси). Исходники и config.json
// остаются нетронутыми — клонировать репозиторий заново не нужно.
function resetRuntime(root) {
  const stopped = stopFleet(root);
  // Дожидаемся корректного завершения клиентов флота (закрытие сокетов), чтобы
  // не удалять accounts/ прямо под пишущими процессами.
  try {
    spawnSync('sleep', ['1500'], { timeout: 5000, stdio: 'ignore' });
  } catch {}
  const removed = [];
  const removePath = (file) => {
    try {
      fs.rmSync(file, { recursive: true, force: true });
      removed.push(path.relative(root, file) || file);
    } catch {}
  };
  removePath(path.join(root, 'accounts'));
  removePath(path.join(root, '.runtime'));
  removePath(path.join(root, '.updates'));
  removePath(path.join(root, 'PacketsDumps'));
  removePath(path.join(root, 'fleet.pid'));
  removePath(path.join(root, 'fleet-status.json'));
  removePath(path.join(root, 'proxy-watch-status.json'));
  removePath(path.join(root, 'working-proxies.txt'));
  removePath(path.join(root, 'working-proxies.json'));
  removePath(path.join(root, 'proxy.json'));
  for (const name of fs.readdirSync(root)) {
    if (/(\.log|\.pid|\.lock|\.tmp-\d+)$/.test(name)) removePath(path.join(root, name));
  }
  // Пустой accounts/ и .runtime/ остаются, чтобы консоль работала сразу после сброса.
  try {
    fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
    fs.mkdirSync(path.join(root, '.runtime', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(root, '.runtime', 'results'), { recursive: true });
  } catch {}
  return { ok: true, stopped, removed: removed.length, paths: removed.sort() };
}

function stopFleet(root) {
  try {
    spawnSync(process.execPath, [path.join(root, 'tools', 'fleet.js'), 'stop'], {
      cwd: root,
      timeout: 30000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

const path = require('node:path');
const fs = require('node:fs');
const Client = require('./Client');
const Actions = require('./Actions');
const Store = require('./Store');
const Accounts = require('./Accounts');
const Protocol = require('./Protocol');
const TagCodec = require('../utils/TagCodec');
const Selection = require('./Selection');
const { createNameGenerator } = require('./Names');
const { codes, codeOf, toJSON } = require('./Errors');

const { integer, target } = Protocol;

// Файлы аккаунтов accounts/*.json (кроме index.json и временных).
function listAccountFiles(root) {
  try {
    return fs
      .readdirSync(path.join(root, 'accounts'))
      .filter((name) => name.endsWith('.json') && name !== 'index.json' && !/(\.tmp-\d+|\.lock)$/.test(name));
  } catch {
    return [];
  }
}

// Статус пишется не чаще 2 раз в секунду; раз в 30 с — heartbeat, даже без изменений.
const STATUS_INTERVAL = 500;
const STATUS_HEARTBEAT = 30000;
const COMMAND_SCAN_INTERVAL = 250;
const STALE_PROCESSING = 600000;
const LOGIN_SAMPLES = 200;

// Признаки ошибки для статуса слота и файла результата: текст остаётся текстом,
// код/категория — отдельными полями, чтобы родитель отличал сеть от отказа сервера.
function errorInfo(error, fallback = {}) {
  if (error === undefined || error === null) return { message: null, code: null, kind: null, retryable: null };
  if (typeof error === 'string')
    return {
      message: error,
      code: fallback.code ?? null,
      kind: fallback.kind ?? null,
      retryable: fallback.retryable ?? null,
    };
  const safe = toJSON(error);
  return {
    message: error.message,
    code: fallback.code ?? codeOf(error),
    kind: fallback.kind ?? safe.kind,
    retryable: safe.retryable,
  };
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// p95 по последним замерам входа; null, пока не было ни одного успешного входа.
function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

// Количество проверенных прокси в пуле; 0, если файла нет или он пуст.
function proxyPoolSize(root, file) {
  if (!file) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const items = Array.isArray(data) ? data : data.proxies;
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

class Fleet {
  constructor(root, options = {}, ClientType = Client) {
    this.root = root;
    this.options = options;
    this.ClientType = ClientType;
    // Явный набор индексов (--bots/--select) важнее первого индекса и количества:
    // так можно запускать/держать в флоте произвольные боты (1,5,10-12, …).
    this.indexes = Array.isArray(options.indexes) && options.indexes.length
      ? [...new Set(options.indexes.map((n) => integer(n, 'indexes', 1, 100000)))].sort((a, b) => a - b)
      : null;
    this.first = this.indexes ? this.indexes[0] : integer(options.first ?? 1, 'first', 1, 100000);
    this.count = this.indexes ? this.indexes.length : integer(options.count ?? 1, 'count', 1, 500);
    this.concurrency = integer(options.concurrency ?? 3, 'concurrency', 1, 200);
    this.commandConcurrency = integer(options.commandConcurrency ?? 8, 'commandConcurrency', 1, 32);
    // Сколько аккаунтов параллельно работает через один прокси (один IP тянет несколько
    // входов; на отказ прокси бот переключается на следующий из пула).
    this.proxyReuse = integer(options.proxyReuse ?? 5, 'proxyReuse', 1, 100);
    if (!options.concurrency && this.options.proxyPoolFile) {
      const poolSize = proxyPoolSize(this.root, this.options.proxyPoolFile);
      if (poolSize > 0) this.concurrency = Math.min(200, Math.max(3, this.proxyReuse * poolSize));
    }
    // Первый вход нового бота включает регистрацию + смену ника + повторный логин —
    // на нагруженном сервере это может занять больше 90 секунд. Держим запас.
    this.slotConnectTimeout = integer(options.slotConnectTimeout ?? 180000, 'slotConnectTimeout', 30000, 600000);
    // Транзиентные сбои (таймаут/сеть) не убивают слота навсегда: до maxSlotRetries
    // авто-попыток с растущей паузой, если только сервер не заблокировал аккаунт.
    this.maxSlotRetries = integer(options.maxSlotRetries ?? 8, 'maxSlotRetries', 0, 50);
    this.slotRetryBackoffMs = integer(options.slotRetryBackoffMs ?? 3000, 'slotRetryBackoffMs', 5, 600000);
    this.statusInterval = integer(options.statusInterval ?? STATUS_INTERVAL, 'statusInterval', 0, 60000);
    this.statusHeartbeat = integer(options.statusHeartbeat ?? STATUS_HEARTBEAT, 'statusHeartbeat', 1000, 3600000);
    this.commandScanInterval = integer(
      options.commandScanInterval ?? COMMAND_SCAN_INTERVAL,
      'commandScanInterval',
      0,
      60000,
    );
    // Команда ждёт «первого входа» слота: аккаунт должен сперва залогиниться, и только потом
    // на нём выполняются клуб/чат/прочие действия. (лимит ожидания)
    this.commandLoginTimeout = integer(options.commandLoginTimeout ?? 90000, 'commandLoginTimeout', 1000, 600000);
    // Очередь вступления в клуб с учётом вместимости: боты, которым не хватило места,
    // ждут освобождения слота вместо мгновенного отказа; выкинутых клубом возвращаем в очередь.
    this.clubTag = options.clubTag || null;
    this.clubFill = !!(options.clubFill || options.fill);
    this.clubFillConcurrency = integer(options.clubFillConcurrency ?? 2, 'clubFillConcurrency', 1, 32);
    this.clubFillRetryMs = integer(options.clubFillRetryMs ?? 15000, 'clubFillRetryMs', 100, 3600000);
    this.clubFillMaxAttempts = integer(options.clubFillMaxAttempts ?? 0, 'clubFillMaxAttempts', 0, 1000);
    this.clubFillCheckMs = integer(options.clubFillCheckMs ?? 10000, 'clubFillCheckMs', 500, 3600000);
    this.clubJoinTimeout = integer(options.clubJoinTimeout ?? 10000, 'clubJoinTimeout', 1000, 120000);
    // Вместимость клуба: очередь не шлёт заявки, когда мест не осталось.
    this.clubCapacity = integer(options.clubCapacity ?? 50, 'clubCapacity', 1, 100000);
    const nameList = options.nameList
      ? String(options.nameList)
          .split(/[,\n]/)
          .map((value) => value.trim())
          .filter(Boolean)
      : null;
    this.nameFor = createNameGenerator({ ...options, list: nameList || options.list || options.names });
    this.clients = new Map();
    this.inflight = 0;
    this.stopping = false;
    this.paused = false;
    this.closed = false;
    this.processing = false;
    this.startedAt = Date.now();
    this.metrics = {
      loggedInTotal: 0,
      failedTotal: 0,
      loginTimes: [],
      launchAt: new Map(),
      commandOk: 0,
      commandError: 0,
      lastCommandAt: null,
    };
    this.registryWarned = false;
    this.commandWarned = false;
    // Состояние очереди в клуб: какие слоты хотят вступить и что с ними сейчас.
    this.clubWanted = new Set();
    this.clubFull = null;
    this.clubKnown = false;
    this.clubMemberCount = null;
    this.clubMemberTags = null;
    this.clubLastCheckAt = 0;
    this.clubPumping = false;
    this.clubConsecutiveFailures = 0;
    this.clubUnavailableUntil = 0;
    this.runtime = path.join(root, '.runtime');
    this.commandDir = path.join(this.runtime, 'commands');
    this.statusFile = path.join(root, 'fleet-status.json');
    fs.mkdirSync(this.commandDir, { recursive: true });
    fs.mkdirSync(path.join(this.runtime, 'results'), { recursive: true });
    const slotIndexes = this.indexes || Array.from({ length: this.count }, (_, n) => this.first + n);
    // Уже сохранённые аккаунты: свои файлы bot-N.json; прочие (например probe.json)
    // «усыновляются» ближайшим слотом без файла — флот входит в накопленные аккаунты
    // по сохранённым токенам вместо создания новых.
    const fileNames = listAccountFiles(root);
    const adoptable = fileNames.filter((name) => !/^bot-\d+\.json$/.test(name)).sort();
    let adoptedCursor = 0;
    this.accountFile = new Map();
    this.slots = slotIndexes.map((index, position) => {
      let file = `bot-${index}.json`;
      if (!fileNames.includes(file) && adoptedCursor < adoptable.length) {
        file = adoptable[adoptedCursor++];
      }
      this.accountFile.set(index, file);
      return {
      index,
      ordinal: position + 1,
      file,
      status: 'queued',
      registered: false,
      joined: false,
      attempts: 0,
      error: null,
      errorCode: null,
      errorKind: null,
      failureCounted: false,
      rttMs: null,
      rttSamples: 0,
      launchRetries: 0,
      retryAt: 0,
      clubState: null,
      clubAttempts: 0,
      clubNextAt: 0,
      };
    });
    for (const slot of this.slots) {
      let account;
      try {
        account = Store.read(path.join(root, 'accounts', slot.file), {});
      } catch (error) {
        const info = errorInfo(error);
        slot.status = 'failed';
        slot.error = `Повреждён accounts/${slot.file}: ${error.message}`;
        slot.errorCode = info.code;
        slot.errorKind = info.kind;
        continue;
      }
      slot.registered = !!(account.passToken && (account.hi || account.lo));
      slot.name = account.name || null;
      slot.tag = account.lo ? TagCodec.logicLongToTag(account.hi, account.lo) : null;
    }
    this.readyCursor = 0;
    this.anyCursor = 0;
    this.flushTimer = null;
    this.lastWriteAt = 0;
    this.lastPayload = null;
    this.lastScanAt = 0;
  }
  statusData(updatedAt) {
    const states = {};
    for (const slot of this.slots) states[slot.status] = (states[slot.status] || 0) + 1;
    return {
      pid: process.pid,
      updatedAt,
      first: this.first,
      requested: this.count,
      clubTag: this.clubTag || null,
      states,
      creationPaused: this.paused ? 'Приостановлено командой пользователя' : null,
      bots: this.slots,
      metrics: this.metricsData(),
    };
  }
  // Все значения пересчитываются при записи статуса, не на каждый пакет.
  metricsData(now = Date.now()) {
    const loginTimes = this.metrics.loginTimes;
    // Среднее и сумма только по онлайн-слотам: у офлайна rttMs — последний известный
    // замер прошлой сессии, он не должен тянуть текущую метрику.
    const rtts = [];
    let rttSamples = 0;
    for (const slot of this.slots) {
      if (slot.status !== 'online' || !Number.isFinite(slot.rttMs)) continue;
      rtts.push(slot.rttMs);
      rttSamples += slot.rttSamples || 0;
    }
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      totalBots: this.slots.length,
      registered: this.slots.filter((slot) => slot.registered).length,
      online: this.slots.filter((slot) => slot.status === 'online').length,
      loggedInTotal: this.metrics.loggedInTotal,
      failedTotal: this.metrics.failedTotal,
      avgLoginMs: average(loginTimes),
      p95LoginMs: percentile(loginTimes, 0.95),
      avgRttMs: average(rtts),
      rttSamples: rtts.length ? rttSamples : null,
      commands: {
        ok: this.metrics.commandOk,
        error: this.metrics.commandError,
        pending: this.pendingCommands(),
      },
      lastCommandAt: this.metrics.lastCommandAt,
      club: this.clubQueueSnapshot(),
    };
  }
  // Сводка очереди в клуб для дашборда и команд.
  clubQueueSnapshot() {
    const states = { want: 0, joining: 0, joined: 0, failed: 0 };
    for (const slot of this.slots) if (slot.clubState && states[slot.clubState] != null) states[slot.clubState]++;
    return {
      tag: this.clubTag,
      enabled: this.clubFill,
      ...states,
      full: this.clubFull,
      known: this.clubKnown,
      capacity: this.clubCapacity,
      memberCount: this.clubMemberCount,
      capacityLeft: this.clubKnown ? Math.max(0, this.clubCapacity - (this.clubMemberCount || 0)) : null,
      lastCheckAt: this.clubLastCheckAt ? new Date(this.clubLastCheckAt).toISOString() : null,
    };
  }
  pendingCommands() {
    try {
      return fs.readdirSync(this.commandDir).filter((name) => /^[a-f0-9-]+\.json$/.test(name)).length;
    } catch {
      return 0;
    }
  }
  // Единственное место смены статуса слота: переход в failed/blocked считается один раз
  // на инцидент (slot.failureCounted), а не на каждое последующее событие того же сбоя.
  setStatus(slot, status, error, meta = {}) {
    const previous = slot.status;
    const info = errorInfo(error, meta);
    slot.status = status;
    slot.error = info.message;
    slot.errorCode = info.code;
    slot.errorKind = info.kind;
    if (['failed', 'blocked'].includes(status)) {
      if (!['failed', 'blocked'].includes(previous) && !slot.failureCounted) {
        this.metrics.failedTotal++;
        slot.failureCounted = true;
      }
    } else if (status === 'online' || status === 'queued') {
      // Слот снова живой (или явно перезапущен) — следующий сбой это новый инцидент.
      slot.failureCounted = false;
    }
    return previous;
  }
  // Учитываем вход один раз на переход в online; замер — от launch() до подтверждённого входа.
  recordLogin(slot) {
    this.metrics.loggedInTotal++;
    const started = this.metrics.launchAt.get(slot.index);
    if (!started) return;
    this.metrics.launchAt.delete(slot.index);
    this.metrics.loginTimes.push(Date.now() - started);
    if (this.metrics.loginTimes.length > LOGIN_SAMPLES) this.metrics.loginTimes.shift();
  }
  // Реестр — побочный индекс: любая его ошибка логируется один раз и не роняет флот.
  updateRegistry(slot, account, client) {
    try {
      const file = client?.file
        ? path.relative(this.root, client.file)
        : path.join('accounts', `bot-${slot.index}.json`);
      Accounts.upsert(this.root, account || {}, file);
    } catch (error) {
      if (this.registryWarned) return;
      this.registryWarned = true;
      global.Debugger?.warn?.(`реестр аккаунтов: ${error.message}`);
    }
  }
  // Публичный API сохранён: только помечает статус изменённым и планирует запись.
  snapshot() {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastWriteAt >= this.statusHeartbeat) {
      this.flushStatus();
      return;
    }
    if (this.flushTimer) return;
    const delay = Math.max(0, this.statusInterval - (now - this.lastWriteAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushStatus();
    }, delay);
    this.flushTimer.unref?.();
  }
  flushStatus(force = false) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const now = Date.now();
    const data = this.statusData(new Date(now).toISOString());
    // В сравнение «изменилось ли состояние» не входит только uptimeSec: он растёт сам по себе,
    // иначе запись шла бы каждый интервал. pending и счётчики команд — реальные изменения.
    const comparable = { ...data, updatedAt: null, metrics: { ...data.metrics, uptimeSec: null } };
    const payload = JSON.stringify(comparable);
    // Содержимое не изменилось и heartbeat ещё не истёк — запись пропускается.
    if (!force && payload === this.lastPayload && now - this.lastWriteAt < this.statusHeartbeat) return false;
    Store.write(this.statusFile, data);
    this.lastPayload = payload;
    this.lastWriteAt = now;
    return true;
  }
  start() {
    this.closed = false;
    this.flushStatus(true);
    this.pump();
    this.timer = setInterval(() => {
      this.snapshot();
      this.processCommands().catch((error) => console.error(error.message));
      this.pumpClub().catch((error) => console.error(error.message));
    }, 1000);
  }
  // Курсор по кругу: сначала зарегистрированные боты, затем любой queued.
  nextQueued() {
    const now = Date.now();
    const ready = (slot) => slot.status === 'queued' && slot.retryAt <= now;
    const total = this.slots.length;
    for (let n = 0; n < total; n++) {
      const i = (this.readyCursor + n) % total;
      if (ready(this.slots[i]) && this.slots[i].registered) {
        this.readyCursor = (i + 1) % total;
        return this.slots[i];
      }
    }
    for (let n = 0; n < total; n++) {
      const i = (this.anyCursor + n) % total;
      if (ready(this.slots[i])) {
        this.anyCursor = (i + 1) % total;
        return this.slots[i];
      }
    }
    return null;
  }
  pump() {
    if (this.stopping || this.paused) return;
    while (this.inflight < this.concurrency) {
      const slot = this.nextQueued();
      if (!slot) break;
      this.launch(slot);
    }
  }
  async launch(slot) {
    this.inflight++;
    this.metrics.launchAt.set(slot.index, Date.now());
    slot.status = 'connecting';
    let initial = true,
      client,
      connectDeadline;
    try {
      client = new this.ClientType({
        root: this.root,
        account: `accounts/${this.accountFile.get(slot.index) || `bot-${slot.index}.json`}`,
        index: slot.index,
        name: slot.name || this.nameFor(slot.index, slot.ordinal),
        reconnect: true,
        proxyFile: this.options.proxyFile,
        proxyPoolFile: this.options.proxyPoolFile,
        proxyReuse: this.options.proxyReuse,
        dump: this.options.dump,
        battleTransport: this.options.battleTransport,
      });
      this.clients.set(slot.index, client);
      client.peers = this.clients;
      client.on('state', ({ state, error, code, kind }) => {
        if (this.clients.get(slot.index) !== client) return;
        const previous = this.setStatus(slot, state, error, { code, kind });
        slot.attempts = client.attempts || 0;
        if (state === 'online' && previous !== 'online') this.recordLogin(slot);
        this.snapshot();
      });
      client.on('warning', (error) => {
        if (this.clients.get(slot.index) !== client) return;
        const info = errorInfo(error);
        slot.error = info.message;
        slot.errorCode = info.code;
        slot.errorKind = info.kind;
        console.error(`bot=${slot.index} ${error.message}`);
      });
      client.on('account', (account) => {
        if (this.clients.get(slot.index) !== client) return;
        slot.registered = !!(account.passToken && (account.hi || account.lo));
        slot.name = account.name || null;
        slot.tag = account.lo ? TagCodec.logicLongToTag(account.hi, account.lo) : null;
        if (this.clubTag) slot.joined = Actions.same(account.club, target(this.clubTag));
        this.updateRegistry(slot, account, client);
        this.snapshot();
      });
      client.on('packet', () => {
        slot.lastServerAt = client.lastServerAt;
        slot.matchmaking = client.matchmaking || null;
        slot.rttMs = Number.isFinite(client.rttMs) ? client.rttMs : null;
        slot.rttSamples = client.rttSamples || 0;
      });
      const timeoutSec = Math.round(this.slotConnectTimeout / 1000);
      connectDeadline = setTimeout(() => {
        if (initial) {
          // Метка, чтобы catch не подменил осмысленный таймаут строкой close() ('Клиент остановлен').
          slot.timeoutError = new AppError(codes.TIMEOUT, `Вход/ник не подтверждены за ${timeoutSec} секунд`, {
            kind: 'timeout',
            details: { stage: slot.status, timeoutMs: this.slotConnectTimeout },
          });
          client.close();
          this.setStatus(slot, 'failed', slot.timeoutError);
        }
      }, this.slotConnectTimeout);
      connectDeadline.unref?.();
      const join = async () => {
        slot.onlineSince = client.onlineSince;
        slot.joined = false;
        if (client.account) this.updateRegistry(slot, client.account, client);
        if (!this.clubTag) return;
        const inClub = Actions.same(client.club, target(this.clubTag));
        if (inClub) {
          slot.joined = true;
          slot.clubState = 'joined';
          this.setStatus(slot, client.state);
          return;
        }
        if (this.clubFill) {
          // Уже в клубе? Нет — ставим в очередь и не ждём: вместимость и повторы
          // разрулит pumpClub, чтобы один «полный клуб» не тормозил остальных.
          this.clubWanted.add(slot.index);
          slot.clubState = 'want';
          slot.clubNextAt = 0;
          slot.clubAttempts = 0;
          this.setStatus(slot, client.state);
          this.snapshot();
          this.pumpClub().catch((error) => console.error(error.message));
          return;
        }
        this.setStatus(slot, 'joining-club');
        try {
          if (!inClub) await Actions.execute(client, 'join-club', { clubTag: this.clubTag });
          slot.joined = Actions.same(client.club, target(this.clubTag));
          slot.clubError = null;
        } catch (error) {
          const info = errorInfo(error);
          slot.clubError = info.message;
          slot.clubErrorCode = info.code;
          slot.clubErrorKind = info.kind;
          console.error(`bot=${slot.index} ${error.message} (${info.code || info.kind || 'unknown'})`);
        }
        this.setStatus(slot, client.state);
        this.snapshot();
      };
      client.on('online', () => {
        if (this.clients.get(slot.index) !== client || this.stopping) return;
        slot.launchRetries = 0;
        slot.retryAt = 0;
        if (!initial) join().catch((error) => console.error(error.message));
      });
      await client.connect();
      initial = false;
      clearTimeout(connectDeadline);
      await join();
    } catch (error) {
      initial = false;
      clearTimeout(connectDeadline);
      const blocked = !!client?.permanentError;
      client?.close();
      // Здесь abandon-таймаут 90→180с и его сообщение должны выживать, а не тонуть
      // в строке 'Клиент остановлен', которой close() отклоняет openPromise.
      const info = errorInfo(error);
      const effective = slot.timeoutError && /Клиент остановлен/.test(info.message) ? slot.timeoutError : error;
      slot.timeoutError = null;
      this.setStatus(slot, blocked ? 'blocked' : 'failed', effective);
      if (!blocked) this.scheduleRetry(slot);
    } finally {
      this.inflight--;
      this.snapshot();
      this.pump();
    }
  }
  // Транзиентная неудача (таймаут первого входа, капля сети) не должна хоронить слота:
  // возвращаем его в очередь с растущей паузой. Постоянные профильные ошибки (blocked)
  // здесь не проходят — для них остаётся ручной `retry`.
  scheduleRetry(slot) {
    if (this.stopping || this.closed || slot.status !== 'failed') return;
    const retries = (slot.launchRetries = (slot.launchRetries || 0) + 1);
    if (retries > this.maxSlotRetries) return;
    const delay = Math.min(60000, this.slotRetryBackoffMs * retries);
    slot.retryAt = Date.now() + delay;
    this.setStatus(slot, 'queued', null);
    this.snapshot();
    const timer = setTimeout(() => this.pump(), delay);
    timer.unref?.();
  }
  async processCommands() {
    if (this.processing || this.stopping) return;
    this.processing = true;
    const jobs = [];
    try {
      const now = Date.now();
      if (now - this.lastScanAt < this.commandScanInterval) return;
      this.lastScanAt = now;
      this.cleanupStale(now);
      let names;
      try {
        names = fs.readdirSync(this.commandDir).filter((n) => /^[a-f0-9-]+\.json$/.test(n));
      } catch (error) {
        // Каталог могли удалить (cleanup, ручная чистка, смена прав) — пересоздаём и живём дальше.
        if (error.code === 'ENOENT') {
          try {
            fs.mkdirSync(this.commandDir, { recursive: true });
          } catch {}
        } else if (!this.commandWarned) {
          this.commandWarned = true;
          global.Debugger?.error?.(`каталог команд флота: ${error.message}`);
        }
        return;
      }
      // Каждая команда выполняется отдельной задачей: клики по разным кнопкам не ждут
      // друг друга (важно при одновременных «всем ботам» / разных действий).
      for (const name of names) {
        const file = path.join(this.commandDir, name);
        // Атомарный захват: второй тик/процесс уже не увидит *.json.
        const claimed = `${file}.processing`;
        try {
          fs.renameSync(file, claimed);
        } catch {
          continue;
        }
        const resultFile = path.join(this.runtime, 'results', name);
        jobs.push(
          this.runCommandFile(claimed, resultFile).catch((error) => {
            this.metrics.commandError++;
            try {
              Store.write(resultFile, { ok: false, error: error.message || String(error) });
            } catch {}
          }),
        );
      }
    } finally {
      this.processing = false;
    }
    // Await после finally: guard отпущен, следующий тик может захватывать новые файлы,
    // а await всё равно дожидается завершения этих задач (тесты и «одна кнопка в один клик»).
    if (jobs.length) await Promise.all(jobs);
  }
  async runCommandFile(claimed, resultFile) {
    try {
      const item = Store.read(claimed);
      let result;
      if (item.action === 'pause') {
        this.paused = true;
        result = { paused: true };
      } else if (item.action === 'resume') {
        this.paused = false;
        this.pump();
        result = { paused: false };
      } else if (item.action === 'retry') {
        for (const slot of this.slots.filter((s) => ['failed', 'blocked'].includes(s.status))) {
          this.clients.get(slot.index)?.close();
          slot.launchRetries = 0;
          slot.retryAt = 0;
          this.setStatus(slot, 'queued', null);
        }
        this.paused = false;
        this.pump();
        result = { retried: true };
      } else if (item.action === 'reconnect') {
        // Перелогин слота тем же аккаунтом: закрываем клиент и перезапускаем —
        // токен из accounts/bot-N.json переиспользуется (никакого «нового аккаунта»).
        const indexes = this.resolveIndexes(item);
        let done = 0;
        for (const index of indexes) {
          const slot = this.slots.find((s) => s.index === index);
          if (!slot) continue;
          this.clients.get(index)?.close();
          slot.launchRetries = 0;
          slot.retryAt = 0;
          this.setStatus(slot, 'queued', null);
          done++;
        }
        if (!this.paused) this.pump();
        result = { reconnected: done, indexes };
      } else if (item.action === 'club-fill') {
        result = this.wantClub(this.resolveIndexes(item), item.args?.clubTag || item.clubTag, item.args || {});
      } else if (item.action === 'club-cancel') {
        const indexes = this.resolveIndexes(item);
        result = this.cancelClub(indexes.length ? indexes : null);
      } else if (item.action === 'club-queue') {
        result = {
          ...this.clubQueueSnapshot(),
          slots: this.slots
            .filter((s) => s.clubState)
            .map((s) => ({
              index: s.index,
              state: s.clubState,
              attempts: s.clubAttempts,
              error: s.clubError || null,
              nextAt: s.clubNextAt || null,
            })),
        };
      } else if (item.action === 'join-club' && item.queue) {
        result = this.wantClub(this.resolveIndexes(item), item.args?.clubTag, item.args || {});
      } else {
        const indexes = this.resolveIndexes(item);
        if (!indexes.length) throw new Error('выбор не содержит ни одного бота флота');
        result = indexes.length === 1
          ? [await this.runOne(indexes[0], item.action, item.args)]
          : await this.runAll(indexes, item.action, item.args);
      }
      Store.write(resultFile, { ok: true, result });
      this.metrics.commandOk++;
    } catch (error) {
      const info = errorInfo(error);
      Store.write(resultFile, {
        ok: false,
        error: info.message,
        code: info.code,
        kind: info.kind,
        retryable: info.retryable === true,
      });
      this.metrics.commandError++;
    } finally {
      this.metrics.lastCommandAt = new Date().toISOString();
      try {
        fs.unlinkSync(claimed);
      } catch {}
    }
  }
  cleanupStale(now) {
    Accounts.removeStale(this.commandDir, { pattern: /\.processing$/, maxAge: STALE_PROCESSING, now });
  }
  // Действие нельзя применить, пока аккаунт не вошёл: сначала логин, потом клуб/чат/прочее.
  // Ожидаем первый вход до commandLoginTimeout; блокировка профиля/падение прерывают ожидание.
  waitOnline(client, timeout) {
    if (!client) return Promise.resolve(false);
    const done = ['online'].includes(client.state);
    if (done) return Promise.resolve(true);
    const dead = ['blocked', 'failed', 'closed'];
    if (dead.includes(client.state)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeout);
      const onState = ({ state }) => {
        if (state === 'online') {
          cleanup();
          resolve(true);
        } else if (dead.includes(state)) {
          cleanup();
          resolve(false);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.off('state', onState);
      };
      client.on('state', onState);
    });
  }
  async runOne(index, action, args) {
    const client = this.clients.get(index);
    if (!client) return { index, error: 'Бот не запущен', code: codes.STATE_ERROR, kind: 'state', retryable: false };
    const online = await this.waitOnline(client, this.commandLoginTimeout);
    if (!online)
      return {
        index,
        error: `Бот не вошёл за ${Math.round(this.commandLoginTimeout / 1000)} с — действие не применялось`,
        code: codes.TIMEOUT,
        kind: 'timeout',
        retryable: true,
      };
    try {
      return { index, ...(await Actions.execute(client, action, args)) };
    } catch (error) {
      const info = errorInfo(error);
      return { index, error: info.message, code: info.code, kind: info.kind, retryable: info.retryable === true };
    }
  }
  // Ограниченный параллелизм; результаты остаются в порядке возрастания индексов.
  async runAll(indexes, action, args) {
    const results = new Array(indexes.length);
    let next = 0;
    const worker = async () => {
      while (next < indexes.length) {
        const i = next++;
        results[i] = await this.runOne(indexes[i], action, args);
      }
    };
    const workers = Math.min(this.commandConcurrency, indexes.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
  }
  // Индексы из команды: явный список/выбор (--bots), иначе all / один --bot.
  resolveIndexes(item = {}) {
    const available = this.slots.map((slot) => slot.index);
    if (Array.isArray(item.indexes) && item.indexes.length)
      return item.indexes.filter((n) => available.includes(n));
    if (typeof item.select === 'string' && item.select.trim())
      return Selection.parseSelection(item.select, available);
    if (item.all) return available;
    if (item.bot != null) {
      const index = integer(item.bot, 'bot', 1, 100000);
      return available.includes(index) ? [index] : [];
    }
    return [];
  }
  // Поставить ботов в очередь на вступление в клуб. Возвращает сразу — очередь
  // работает в фоне и сама ждёт свободного места, не блокируя HTTP на десятки секунд.
  wantClub(indexes, clubTag, args = {}) {
    const changedTag = !!clubTag && clubTag !== this.clubTag;
    if (clubTag) this.clubTag = clubTag;
    if (!this.clubTag) throw new Error('не указан тег клуба (--club-tag)');
    if (changedTag || !this.clubKnown) {
      // Сброс прежних знаний о вместимости: старый «клуб полон» не должен замораживать
      // очередь после смены клуба.
      this.clubFull = null;
      this.clubKnown = false;
      this.clubMemberCount = null;
      this.clubMemberTags = null;
      this.clubLastCheckAt = 0;
      this.clubConsecutiveFailures = 0;
      this.clubUnavailableUntil = 0;
    }
    this.clubFill = true;
    // Настройки очереди можно менять на лету из команды (--join-concurrency/--join-retry-ms/--join-max-attempts).
    const live = (value, fallback, name, min, max) =>
      value == null || value === '' ? fallback : integer(value, name, min, max);
    this.clubFillConcurrency = live(
      args.joinConcurrency ?? args.clubFillConcurrency,
      this.clubFillConcurrency,
      'joinConcurrency',
      1,
      32,
    );
    this.clubFillRetryMs = live(args.joinRetryMs ?? args.clubFillRetryMs, this.clubFillRetryMs, 'joinRetryMs', 100, 3600000);
    this.clubFillMaxAttempts = live(
      args.joinMaxAttempts ?? args.clubFillMaxAttempts,
      this.clubFillMaxAttempts,
      'joinMaxAttempts',
      0,
      1000,
    );
    this.clubCapacity = live(args.clubCapacity ?? args.capacity, this.clubCapacity, 'clubCapacity', 1, 100000);
    let queued = 0;
    for (const index of indexes) {
      const slot = this.slots.find((s) => s.index === index);
      if (!slot) continue;
      if (slot.clubState === 'joined') continue;
      this.clubWanted.add(index);
      slot.clubState = 'want';
      slot.clubAttempts = 0;
      slot.clubNextAt = 0;
      queued++;
    }
    this.snapshot();
    this.pumpClub().catch((error) => console.error(error.message));
    return { queued, clubTag: this.clubTag };
  }
  // Снять ботов с очереди (без выхода из клуба). Без списка — выключить очередь целиком.
  cancelClub(indexes) {
    if (!indexes || !indexes.length) {
      const cleared = this.clubWanted.size;
      this.clubWanted.clear();
      this.clubFill = false;
      this.clubFull = null;
      this.clubKnown = false;
      this.clubMemberCount = null;
      this.clubLastCheckAt = 0;
      for (const slot of this.slots) if (slot.clubState === 'want' || slot.clubState === 'joining') slot.clubState = null;
      this.snapshot();
      return { cancelled: cleared, all: true };
    }
    let cancelled = 0;
    for (const index of indexes) {
      if (this.clubWanted.delete(index)) cancelled++;
      const slot = this.slots.find((s) => s.index === index);
      if (slot && (slot.clubState === 'want' || slot.clubState === 'joining')) slot.clubState = null;
    }
    this.snapshot();
    return { cancelled, all: false };
  }
  // Онлайн-клиент, которым можно спросить вместимость клуба. Предпочитаем уже состоящих в клубе.
  pickClubProbe() {
    let fallback = null;
    for (const slot of this.slots) {
      const client = this.clients.get(slot.index);
      if (!client || client.state !== 'online') continue;
      if (client.club && Actions.same(client.club, target(this.clubTag))) return client;
      if (slot.clubState === 'joined' || slot.joined) return client;
      fallback ||= client;
    }
    return fallback;
  }
  async pumpClub() {
    if (!this.clubFill || !this.clubTag || this.stopping || this.closed || this.paused) return;
    if (this.clubPumping) return;
    this.clubPumping = true;
    try {
      const now = Date.now();
      // После серии ошибок чтения клуба держим паузу — не молотим вслепую.
      if (now < this.clubUnavailableUntil) {
        this.snapshot();
        return;
      }
      const candidates = this.slots.filter((slot) => {
        if (slot.clubState !== 'want') return false;
        if ((slot.clubNextAt || 0) > now) return false;
        const client = this.clients.get(slot.index);
        return !!client && client.state === 'online';
      });
      if (!candidates.length) return;
      // Вместимость проверяем не чаще clubFillCheckMs.
      if (this.clubLastCheckAt === 0 || now - this.clubLastCheckAt >= this.clubFillCheckMs) await this.checkClub(now);
      const free = this.freeSlots();
      if (free === 0) {
        // Клуб полон: заявки не отправляем вовсе, боты просто ждут следующей проверки места.
        for (const slot of candidates) slot.clubNextAt = now + this.clubFillCheckMs;
        this.snapshot();
        return;
      }
      // При неизвестной вместимости пробуем по одной заявке, а не пачкой вслепую.
      const want = free == null ? 1 : Math.min(this.clubFillConcurrency, free);
      const batch = candidates.slice(0, want);
      for (const slot of batch) slot.clubState = 'joining';
      this.snapshot();
      await Promise.all(batch.map((slot) => this.joinSlotToClub(slot)));
    } finally {
      this.clubPumping = false;
      this.snapshot();
    }
  }
  freeSlots() {
    if (this.clubFull === true) return 0;
    if (this.clubKnown && Number.isFinite(this.clubMemberCount)) {
      return Math.max(0, this.clubCapacity - this.clubMemberCount);
    }
    return null;
  }
  async checkClub(now) {
    const client = this.pickClubProbe();
    if (!client) {
      this.clubLastCheckAt = now;
      return;
    }
    try {
      const info = await Actions.execute(client, 'club-info', {
        clubTag: this.clubTag,
        timeout: Math.min(8000, this.clubJoinTimeout),
      });
      const club = info && info.club && typeof info.club === 'object' ? info.club : info;
      this.clubLastCheckAt = now;
      this.clubConsecutiveFailures = 0;
      this.clubUnavailableUntil = 0;
      // Список участников сервер присылает только для своего клуба; ёмкость считаем
      // надёжной, только когда спрашивающий реально состоит в клубе.
      const members = club && Array.isArray(club.members) && club.complete !== false ? club.members : null;
      const probeInClub = !!client.club && !!members && Actions.same(client.club, target(this.clubTag));
      const memberCount =
        probeInClub && Number.isFinite(club.memberCount)
          ? club.memberCount
          : members && members.length !== undefined
            ? members.length
            : null;
      this.clubKnown = memberCount !== null;
      this.clubMemberCount = memberCount;
      this.clubMemberTags = members ? new Set(members.map((m) => m.tag).filter(Boolean)) : null;
      this.clubFull = club && club.full === true ? true : this.clubKnown ? memberCount >= this.clubCapacity : null;
      this.clubError = null;
      // Конкретного бота уже нет в составе — его выкинули; ставим обратно в очередь.
      if (this.clubMemberTags) {
        for (const slot of this.slots) {
          if (slot.clubState !== 'joined' || !slot.tag) continue;
          if (this.clubMemberTags.has(slot.tag)) continue;
          slot.clubState = 'want';
          slot.joined = false;
          slot.clubAttempts = 0;
          slot.clubNextAt = 0;
          this.clubWanted.add(slot.index);
        }
      }
    } catch (error) {
      const info = errorInfo(error);
      this.clubError = info.message;
      this.clubLastCheckAt = now;
      this.clubConsecutiveFailures = (this.clubConsecutiveFailures || 0) + 1;
      // Клуб не читается — не лоббируем вслепую: уходим в паузу и пробуем позже.
      if (this.clubConsecutiveFailures >= 2) {
        this.clubKnown = false;
        this.clubUnavailableUntil = now + Math.min(120000, this.clubFillCheckMs * 4);
      }
    }
  }
  async joinSlotToClub(slot) {
    const client = this.clients.get(slot.index);
    if (!client || client.state !== 'online') {
      slot.clubState = 'want';
      slot.clubNextAt = Date.now() + this.clubFillRetryMs;
      this.snapshot();
      return;
    }
    try {
      if (Actions.same(client.club, target(this.clubTag))) {
        slot.clubState = 'joined';
        slot.joined = true;
        slot.clubAttempts = 0;
        slot.clubNextAt = 0;
        this.clubWanted.delete(slot.index);
        this.snapshot();
        return;
      }
      const outcome = await this.requestJoin(client);
      if (outcome.refused) throw new Error(`Клуб отклонил заявку (${outcome.code})`);
      if (!Actions.same(client.club, target(this.clubTag))) throw new Error('сервер не подтвердил вступление в клуб');
      slot.clubState = 'joined';
      slot.joined = true;
      slot.clubError = null;
      slot.clubAttempts = 0;
      slot.clubNextAt = 0;
      this.clubWanted.delete(slot.index);
      // Держим локальный счётчик в актуальном состоянии между опросами club-info,
      // чтобы не переполнить клуб, пока не пришла свежая вместимость.
      if (this.clubKnown && Number.isFinite(this.clubMemberCount)) {
        this.clubMemberCount = Math.min(this.clubCapacity, this.clubMemberCount + 1);
        if (this.clubMemberCount >= this.clubCapacity) this.clubFull = true;
      }
    } catch (error) {
      const info = errorInfo(error);
      slot.clubAttempts = (slot.clubAttempts || 0) + 1;
      slot.clubError = info.message;
      slot.clubErrorCode = info.code;
      slot.clubErrorKind = info.kind;
      // Заявка не прошла при свободных местах — клуб, скорее всего, заполнился между
      // проверкой и заявкой. Консервативно считаем его полным и ждём новой проверки.
      this.clubFull = true;
      this.clubLastCheckAt = 0;
      if (this.clubFillMaxAttempts && slot.clubAttempts >= this.clubFillMaxAttempts) {
        slot.clubState = 'failed';
        this.clubWanted.delete(slot.index);
      } else {
        slot.clubState = 'want';
        slot.clubNextAt = Date.now() + Math.max(this.clubFillCheckMs, this.clubFillRetryMs * slot.clubAttempts);
        this.clubWanted.add(slot.index);
      }
    } finally {
      this.snapshot();
    }
  }
  // Отправка заявки в клуб с быстрым разбором ответа: сервер отвечает 24333 (чек),
  // и отказ становится известен сразу, а не через таймаут ожидания подтверждения 24399.
  requestJoin(client) {
    const message = Protocol.encode('join-club', { clubTag: this.clubTag });
    const targetClub = target(this.clubTag);
    const waiter = client.wait(
      [24399, 24333],
      (packet) => {
        if (packet.type === 24333) return !!(client.clubResponse && typeof client.clubResponse.code === 'number');
        return !!client.club && Actions.same(client.club, targetClub);
      },
      [24332],
      this.clubJoinTimeout,
    );
    client.messaging.send(message.id, message.payload, message.version);
    return waiter.promise.then((packet) =>
      packet.type === 24333
        ? { refused: true, code: client.clubResponse ? client.clubResponse.code : null }
        : { refused: false },
    );
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const client of this.clients.values()) client.close();
    for (const slot of this.slots) slot.status = 'stopped';
    this.flushStatus(true);
    // Финальный flush реестра: иначе отложенная запись (до 5 с) теряется на SIGTERM/SIGINT.
    try {
      Accounts.flush(this.root);
    } catch (error) {
      global.Debugger?.warn?.(`реестр аккаунтов: ${error.message}`);
    }
    this.closed = true;
  }
}
module.exports = Fleet;

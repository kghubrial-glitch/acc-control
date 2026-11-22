# nulls headless client

**EN** · [TR](README.tr.md) · [ZH](README.zh.md)

[![ci](https://github.com/kghubrial-glitch/acc-control/actions/workflows/ci.yml/badge.svg)](https://github.com/kghubrial-glitch/acc-control/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/kghubrial-glitch/acc-control)](https://github.com/kghubrial-glitch/acc-control/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A Node.js client for the **Nulls Brawl 69.252** protocol: accounts, clubs, lobby, friends,
battle spectating and several online sessions at once. No game, no root, no APK patching —
only the network and the protocol.

The project is unofficial and not affiliated with Supercell or Nulls. The code is MIT
([`LICENSE`](LICENSE)); the disclaimers about the game, assets and dumps are in
[`NOTICE.md`](NOTICE.md).

You only need Node.js 20+: the client runs on **Windows, Linux, macOS and Android (Termux)**.
What works where and what the limits are — [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## What it does

| Area | Capabilities |
|---|---|
| Accounts | guest creation, login with a saved token, region, device change, file lock against two sessions |
| Clubs | create, join, chat, stream, requests, roles, kick, invites, settings, top, recommendations |
| Lobby | create a room and join by code, invite a friend or clubmate, replies, mode and map, readiness |
| Friends | add by tag, accept, decline, remove, list and online |
| Battle | matchmaking, cancel, battle load, UDP frames, Brawl TV and player spectating |
| Fleet | run dozens of bots, command them on the fly, pause and resume, statuses |
| Interface | interactive menu, CLI, five languages (ru / en / tr / zh / ar), JSON output for scripts |
| Connect | Nulls Connect: PIN to e-mail, bearer token, bind of a game account |

What has been verified against a live server and what has not —
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) and `node Program.js features`.

## Quick start

### Single file

Download `Nulls.js` from the [latest release](https://github.com/Patrick-9936/nulls-headless-client/releases/latest)
and run:

```sh
node Nulls.js
```

You need Node.js 20+, dependencies are already inside. Controls: arrow keys, enter, esc, ctrl+c.
On the first run a `.nulls-single-<version>` directory appears next to the script — keep it,
it holds your saved logins. Details: [`docs/TUI.md`](docs/TUI.md).

### From git

```sh
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client
npm ci --ignore-scripts
node TUI.js
```

### Termux

Unpack into your **home directory**, not shared Android storage — there are no write
permissions for state files there:

```sh
pkg install nodejs unzip
unzip /sdcard/Download/nulls-headless-client-0.3.2.zip -d "$HOME"
cd ~/nulls-headless-client-0.3.4
node Program.js create-account --account accounts/bot-1.json --name 'MyBot' --once
node Program.js login --account accounts/bot-1.json
```

The zip already contains the dependencies and the license block. The nickname is set at
registration and cannot be changed later.

## Web console

Run the same client as a website from a single file, `server.js` (Node built-ins only, no extra
dependencies):

```sh
npm start                 # http://localhost:3000
PORT=8080 node server.js  # custom port
HOST=0.0.0.0 node server.js  # listen on all interfaces (default)
WEB_TOKEN=secret node server.js  # optional: require a token for the web UI
```

The page provides a dashboard, a terminal (any `node Program.js …` command), and panes for
accounts, bot fleet, clubs/friends, lobby and config. Every button runs the same CLI command
on the server with `--json`, so the behaviour matches the terminal. On hosting panels the
allocated port is usually passed in `PORT` or `SERVER_PORT` automatically.

**Arabic is the default account language.** `config.json` ships with
`"locale": "ar-SA"` / `"preferredLanguage": "ar"` / `"localeIndex": 2`, and the login handshake
sends the game language as a LOCALE data reference (`class 1`, index from the game's
`csv_logic/locales.csv`: 0=EN, 2=AR, 17=RU, 18=TR), which is what actually places the account
into the matching in-game community. Because of that, new **and existing** accounts appear in
Arabic. A per-run `--locale` / `--preferred-language` / `--locale-index` still wins.
The **Accounts** pane has a *Set all accounts to Arabic* button (and the Config pane's Arabic
button does the same) which rewrites `locale` / `preferredLanguage` / `localeIndex` in every
`accounts/*.json` so already-created accounts move to the Arabic community on their next login.
The web interface itself can be switched to Arabic too (`lang ar`, or Config → interface language).

For many accounts at once use the **Fleet** pane: set first/count/name-prefix and a **club
tag**, then Start — every bot is created and logged in, and each one joins that club
(`node tools/fleet.js start --first 1 --count 20 --name-prefix Bot --club-tag #TAG`). The
Bots table shows each account's name, tag, club, status, whether it already has a saved token
and its RTT. Tick **All bots** to send one command to every bot, e.g. `join-club --club-tag #TAG`
or `leave-club`.

**Stopping or pausing never destroys accounts.** Each bot writes its token to
`accounts/bot-<index>.json` on first login; launching the fleet again logs those same bots back
in — no new accounts are created. The pane shows this live: stat cards update automatically
while the tab is open, and every row has its own **Relogin / Join / Leave / Chat / Info**
buttons, so each bot can be driven individually from the browser
(`node tools/fleet.js command --bot 1 --action reconnect` reconnects one bot with its stored
token; `--all` does the whole fleet).

The **Command a bot** panel now exposes the full command set (login, clubs, friends, lobby,
matchmaking, spectate, Brawl TV, roster tools…); the line under the selector shows the
parameters each action expects. Club & Friends and Lobby & Battle panes carry ready-made forms
for the frequent operations. The **Proxies** tab manages free proxies for IP rotation (see below).
## Accounts

`accounts/*.json` contain `passToken` — that is the login. Keep these files safe: deleting an
account creates a new guest instead of restoring the old one. One account file may be used by
only one session at a time; this is protected by `lib/AccountLock.js` and the `.lock` file.

The release archive contains no ready-made accounts — only code, dependencies and the license block.

## Interface language

```sh
node Program.js lang           # current language, mode and source
node Program.js lang tr        # pin the language in config.json
node Program.js lang auto      # return to system auto-detection
node Program.js help --lang en # single run in another language
```

Supported: `ru`, `en`, `tr`, `zh`, `ar`. Auto mode (`uiLanguage: "auto"`) is on by default:
the language is taken from `NULLS_LANG` / `LC_ALL` / `LC_MESSAGES` / `LANG`, then from the
Node system locale (`Intl`), otherwise `ru`. An explicit `--lang` beats the config, and a
concrete code in `uiLanguage` beats the environment.

Switching the interface language does **not** change the login layout: `locale` only goes to
the legacy login, and `preferredLanguage` / `storefront*` only to the modern one — enabling
modern blindly is unsafe (issue #3). How to add your own language —
[`docs/I18N.md`](docs/I18N.md).

## Multiple bots

```sh
node tools/fleet.js start --first 1 --count 3 --name-prefix 'MyBot' --concurrency 3
node tools/fleet.js status
node tools/fleet.js command --bot 1 --action create-club --club-name 'OurClub'
node tools/fleet.js command --bot 2 --action join-club --club-tag '#TAG_FROM_THE_ANSWER'
node tools/fleet.js stop
```

`--first` and `--count` define the files `accounts/bot-N.json`, `--name-prefix` only applies to
new accounts. A single bot's error does not freeze the queue: the refusal is visible in
`clubError`, and an already-logged-in bot stays online. There are `retry`, `pause`, `resume`.

The first login of a brand-new bot (registration + nickname + re-login) is given up to
`--slot-connect-timeout` (default 180 s, was 90 s). A bot that fails for a transient reason
(timeout, dropped connection) is **re-queued automatically** — up to `--max-slot-retries`
(default 8) retries with a growing pause (`--slot-retry-backoff-ms`, default 3 s), so a busy
server no longer leaves most of a big fleet stuck in `failed`. Persistent refusals
(e.g. `blocked`) are not retried automatically; `retry` replays those manually.

**Login comes first, then everything else.** A `command` (and every web button) waits until the
target bot is actually online before running — up to `--command-login-timeout` (default 90 s) —
instead of failing with “not logged in yet”. While bots are still logging in, commands simply
queue; command files are executed in parallel, so clicking several buttons at once does not make
later clicks wait. Login parallelism goes up to `--concurrency 200`; with a proxy pool it even
auto-sizes to `reuse × pool size`.

Rate limiting is **not** login-only: once connected, every action (club joins, chat, friends,
commands…) runs on the bot's existing proxied socket, so a fleet spread over the pool performs
actions from many IPs at once, and a reconnect silently re-rotates to another IP.

The background process writes `fleet.log` and `fleet-status.json`, reconnects after a drop and
asks for a Termux wake-lock (no-op on Windows/Linux/macOS). Android may still kill Termux — for
24/7 operation you need a server, not a phone. The process existing does not mean all bots are
logged in: look at `states` and `bots`. `--timeout` is in milliseconds.

### Watching and registry

```sh
node Program.js watch                    # live dashboard: statuses, metrics, fleet.log tail
node Program.js watch --once --json      # single frame as JSON
node tools/accounts.js list              # registry accounts/index.json: tags, names, clubs
node tools/accounts.js stats
node tools/accounts.js prune --dry-run   # what can be removed, without deleting anything
```

`watch` reads `fleet-status.json`, `fleet.pid`, `fleet.log`, `accounts/index.json` and
`.runtime/results`; flags `--interval`, `--log-lines`, `--bots 1:13`, `--no-color`:
[`docs/WATCH.md`](docs/WATCH.md). The registry and `prune` (files with tokens are never
deleted): [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md).

`fleet-status.json` contains `metrics`: uptime, logins, failures, `avgLoginMs`, `p95LoginMs`,
`avgRttMs` (request→response time, window 50) and command counters. The status is written at
most twice a second (event coalescing); `--status-interval 0` returns a record on every change.
`fleet.log` is rotated (5 MB × 3 archives, `--log-max-bytes`, `--log-keep`), `.runtime` is
cleaned of old results and stuck commands. Details — [`docs/FLEET.md`](docs/FLEET.md).

## Lobby and battle

Lobby and battle commands are best sent through `fleet command`: that keeps one online session
instead of opening a new one for each command.

```sh
node tools/fleet.js command --bot 1 --action create-room --type 0
node tools/fleet.js command --bot 1 --action chat --text 'Hi'
node tools/fleet.js command --bot 1 --action matchmake
node tools/fleet.js command --bot 1 --action cancel-matchmake
node tools/fleet.js command --bot 1 --action leave-room
```

`--type 0` is a normal team, `--type 1` is a friendly battle. In a normal team the server
forbids identical brawlers. Choosing a brawler in the lobby is `team-brawler --brawler <id> [--slot 0]`
(packet 14375, experimental: the layout was recovered from libg and the live server has not
confirmed it yet — see [`docs/REQUESTS.md`](docs/REQUESTS.md)). `--battle-transport udp`
enables battle frame reception and neutral packets; movement and attacks are not implemented:
[`docs/BATTLE_UDP.md`](docs/BATTLE_UDP.md).

Matchmaking progress (`x/6`, `x/10`) comes from the server and is visible in the `matchmaking`
status. In `tools/candidates.js` the next bot by default waits for the previous bot's match
assignment (`--max-queued 1`): [`docs/MATCHMAKING.md`](docs/MATCHMAKING.md).

The full list of commands and options is in [`docs/COMMANDS.md`](docs/COMMANDS.md); feature
statuses — `node Program.js features`.

An important project rule: successfully sending a packet is not a completed action. If the
server did not confirm, you get `confirmed: false`, a refusal or a timeout. Requests, regions
and built-in bots: [`docs/REQUESTS.md`](docs/REQUESTS.md). Unverified commands are marked
experimental and require `--experimental`.

## Nulls Connect

Binding a game account to an identity on `connect.nulls.gg`: PIN to e-mail, bearer token, bind
by JWT from `LoginOk`.

```sh
node tools/connect.js pin --email you@example.com
node tools/connect.js confirm --email you@example.com --pin 1234
node tools/connect.js bind --account accounts/bot-1.json     # bind
node tools/connect.js links
node tools/connect.js unbind --account accounts/bot-1.json   # unbind
node Program.js login --account accounts/bot-1.json --connect-bind  # bind right on login
```

The token is stored in `.runtime/connect.json` with `0600` permissions and never enters git.
`--connect-bind` is optional: without a bind token or bearer the step is skipped and the login
stays successful. Full flow, environment variables and the error table:
[`docs/CONNECT.md`](docs/CONNECT.md).

## Custom scripts

Scripts can live outside the repository and be copied into `tools/`: they import the client
modules with relative paths. The compatibility contract — what is guaranteed and what may
change — is in [`docs/SCRIPTS.md`](docs/SCRIPTS.md).

```sh
cp /sdcard/nulls-tools/*.js ~/nulls-headless-client/tools/
cd ~/nulls-headless-client
node tools/club-rush.js help
```

The repository already ships `tools/fleet.js` (fleet), `tools/connect.js` (Nulls Connect),
`tools/candidates.js` (candidate registration with a memory budget), `tools/proxy-watch.js`
(working-proxy collection) and `tools/test-session.js` (a limited integration test).

## Updating for a new APK

```sh
node Program.js update --check
node Program.js update --account accounts/offline-bot.json
node Program.js update --watch --interval 1800 --account accounts/offline-bot.json
node Program.js update --rollback
```

The updater reads the installed APK and the server fingerprint; changes are applied after
checking `LoginOk` and `Home`. You need an existing **offline** account: the lock prevents two
sessions from logging in at once. For the APK there are `--apk PATH`, `--split-apk PATH`, and
for resources `--no-apk`; extraction requires python and aapt2. The script does not download the
game. A cryptography change in the next major may require code changes — compatibility with v70
is not guaranteed.

How to update `config.json` and the license block manually:
[`docs/APK-UPDATE.md`](docs/APK-UPDATE.md).

## Proxy — free IP rotation against rate limits

If mass registration or joins throttle your IP, route fleet logins through free proxies: every
bot (and every reconnect) connects from a different source IP.

```sh
# one check pass, then launch with rotation:
node tools/proxy-watch.js once --limit 240
node tools/fleet.js start --first 1 --count 100 --free-proxies

# or keep the pool fresh in the background:
node tools/proxy-watch.js start --interval 600
node tools/fleet.js start --first 1 --count 100 --proxy-pool-file working-proxies.json
node tools/proxy-watch.js status
node tools/proxy-watch.js stop
```

`--free-proxies` runs one `once` pass (unless the pool is < 10 min old) and adds the pool
automatically. `working-proxies.json` is (re)written on every batch; a proxy is added only if it
answered the game server with a correct `ServerHello`, so the pool only contains reachable IPs.

One proxy is **reused for several accounts at once** (`--proxy-reuse`, default 5): the pool is no
longer 1 IP = 1 bot. Bots are grouped so a proxy handles up to N simultaneous logins, and when a
proxy fails a bot automatically moves to the next proxy in the pool. With a pool of 3 proxies and
the default reuse, `fleet start` auto-raises concurrency to 3×5 = 15 parallel logins; override it
with `--concurrency` (supported up to 200). If the pool is empty or missing, everything falls back
to the direct IP.

Single proxy without rotation:

```sh
node Program.js login --account accounts/bot-1.json --proxy-file proxy.json
```

`proxy.json`: `{"url":"socks5://HOST:PORT"}` or
`{"url":"http://HOST:PORT","username":"USER","password":"PASS"}`. `--proxy-pool-file
working-proxies.json` also works without `once`. Device traffic is not redirected — only the
game connections go through the tunnel.

In the web console the **Proxies** tab does the same thing: Start watcher / Fetch once / Refresh
now / Stop, pool size in the status box, and the *Use for the fleet* toggle makes **Launch
bots** add `--proxy-pool-file working-proxies.json`. If the pool is empty the flag is dropped
automatically and bots fall back to the direct IP, so a batch never silently dies.

## Diagnostics

```sh
node Program.js help
node Program.js info
node Program.js features
node Program.js room-code X5AMWKM
node Program.js tag-decode '#GL0J2CPP0'
node Program.js account-info --account accounts/bot-1.json
```

`--dump` saves packets to `PacketsDumps/`, including login data: do not publish dumps or tokens.
A room code reveals its ID but not past or future rooms: [`docs/ROOM_CODES.md`](docs/ROOM_CODES.md).
Age is not confirmed in Nulls, `--age` is rejected. Supercell ID is not implemented; friends
work by game tag.

Brawl TV: `brawl-tv`, `brawl-tv-channels`, `brawl-tv-next` — [`docs/BRAWL_TV.md`](docs/BRAWL_TV.md).
A limited Codespaces test — [`docs/CODESPACES.md`](docs/CODESPACES.md).

## Development

```sh
npm ci --ignore-scripts
npm test            # node --test, the whole suite
npm run check       # syntax + info
npm run lint        # same, for CI
node Nulls.js --self-test
```

A single test: `node --test tests/<file>.test.js`. Style is prettier and editorconfig in the
root; rules are in `eslint.config.mjs`. How the repository is organised and how to add a command
or package: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). How to contribute:
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Release build

```sh
npm run bundle        # zip + Nulls.js + sha256
npm run bundle:check  # rebuild into $TMPDIR and compare with the committed Nulls.js
```

The build is reproducible: `node_modules/.package-lock.json`, npm caches and
`node_modules/.bin` do not make it into the bundle, zip timestamps are fixed, so the archive is
built byte-for-byte. The content of `Nulls.js` is verified by CI against a hash (not the file
bytes: gzip itself depends on the zlib version). A mismatch fails CI red. `Nulls.js` in the
root is the built single file; the launch template is `tools/single-file.template`. Tag
`vX.Y.Z` starts the release workflow; step by step — [`docs/RELEASING.md`](docs/RELEASING.md).

## Documentation

| File | About |
|---|---|
| [`docs/COMMANDS.md`](docs/COMMANDS.md) | all commands, flags, examples |
| [`docs/REQUESTS.md`](docs/REQUESTS.md) | invites, requests, regions, built-in bots |
| [`docs/MATCHMAKING.md`](docs/MATCHMAKING.md) | matchmaking, queues, unknown outcome |
| [`docs/BATTLE_UDP.md`](docs/BATTLE_UDP.md) | battle frames over UDP |
| [`docs/BRAWL_TV.md`](docs/BRAWL_TV.md) | spectating and channels |
| [`docs/ROOM_CODES.md`](docs/ROOM_CODES.md) | room codes |
| [`docs/TUI.md`](docs/TUI.md) | menu, navigation, forms |
| [`docs/I18N.md`](docs/I18N.md) | interface languages and how to add your own |
| [`docs/CONNECT.md`](docs/CONNECT.md) | Nulls Connect |
| [`docs/SCRIPTS.md`](docs/SCRIPTS.md) | contract for external scripts |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | project internals |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | what was verified on a live server |
| [`docs/APK-UPDATE.md`](docs/APK-UPDATE.md) | updating for a new APK |
| [`docs/RELEASING.md`](docs/RELEASING.md) | releasing a version |
| [`docs/CODESPACES.md`](docs/CODESPACES.md) | limited integration test |
| [`docs/FLEET.md`](docs/FLEET.md) | fleet: statuses, commands, limits |
| [`docs/WATCH.md`](docs/WATCH.md) | the `watch` dashboard, `--json` / `--quiet` |
| [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md) | account registry, `prune`, tokens |
| [`docs/ERRORS.md`](docs/ERRORS.md) | error codes for scripts |
| [`docs/PLATFORMS.md`](docs/PLATFORMS.md) | Windows, Linux, macOS, Android |

## Limitations

- The game is not launched: the client speaks the protocol but does not render or play.
- Brawler control, movement and attacks are not implemented.
- Server-side club recommendations and ranking stay on the server side.
- `Supercell ID`, age confirmation, changing an already-set nickname are not supported.
- Long-term bot operation on a phone hits Android limitations, not the client.

## License

The repository code is MIT ([`LICENSE`](LICENSE)). Rights to the game, its assets and APK data
belong to their owners; `client-license.bin` is not covered by MIT. The project is unofficial.


# AGENTS.md

This file provides guidance to Agentic AI Coding tools when working with code in this repository.

## Build, Lint, Run

The build orchestrator is `stx` (config: `etc/stx.conf`). The single npm
script `npm start` delegates to it. Run targets as `npm start <target>`:

- `npm start lint`         — ESLint over `src/*.ts` (config `etc/eslint.mts`)
- `npm start build`        — runs `lint`, then `tsc --project etc/tsc.json` (emits to `dst/`)
- `npm start clean`        — remove `dst/`
- `npm start distclean`    — `clean`, then remove `package-lock.json` and `node_modules/`
- `npm start frontend`     — `node dst/junction-cli.js frontend`
- `npm start backend`      — `node dst/junction-cli.js backend`
- `npm start broker`       — `node dst/junction-cli.js broker` (bundled Mosquitto MQTT broker)
- `npm start orchestrator` — `node dst/junction-cli.js orchestrator …` against `etc/junction-local.yaml`
- `npm start package` / `publish` — Docker image build/push (host-gated to `en4.*`)
- `npm start docker-run` / `docker-exec` / `docker-backend` — local Docker helpers
  (the `docker-run` helper targets the `haproxy` router config; running the
  `nftables` router type in a container additionally requires
  `--network=host --cap-add=NET_ADMIN`)

There is no test suite. A typical local dev loop is one of:

- *Manual*: start the broker, then the backend (with `-d <dir>`), then
  the frontend (with `-l <url>`), all pointing at the same `mqtt://...`
  URL.
- *Orchestrated*: run a single `orchestrator` against a YAML config
  (`etc/junction-local.yaml`), which generates all config files and
  spawns the whole HAProxy + Mosquitto + frontend topology for you.

## Architecture

Junction is an **HTTP/REST-over-MQTT gateway** that exposes a filesystem
directory to HTTP clients through an MQTT broker. The core is
intentionally split into three independently runnable processes, plus an
*orchestrator* that wires up an entire production-style topology:

```
HTTP client → [frontend] →(MQTT)→ broker →(MQTT)→ [backend] → filesystem
```

- **`src/junction-api-frontend.ts`** (`JunctionFrontend`): Hapi HTTP
  server with an in-memory `lru-cache` of fetched assets. On a request
  miss, it `fetch`es the resource over MQTT+ from any backend. It also
  exposes two MQTT+ *services* (`frontend/refresh`, `frontend/delete`)
  that backends call when files change, so caches stay coherent. Supports
  `If-Modified-Since` / `304`. Cache entries are keyed under the
  *canonical* path the backend resolved (e.g. `""` → `index.html`),
  reported back in the fetch `meta.path`, and additionally aliased under
  the originally requested path so cache-coherence events still match.
  Constructor: `new JunctionFrontend(listenUrl, connectUrl, options)`.

- **`src/junction-api-backend.ts`** (`JunctionBackend`): Watches a
  directory with `chokidar` and exposes a `backend/fetch` MQTT+ *source*
  that streams file contents with `{ path, type, modified }` meta. MIME
  type is detected via `file-type` then `mime-types`. Directory and
  `index.html` fallback are handled here, plus a path-traversal guard
  against escaping the served root. On `add`/`change`/`unlink` it calls
  the frontend's `frontend/refresh` / `frontend/delete` services.
  Constructor: `new JunctionBackend(directory, connectUrl, options)`.

- **`src/junction-api-broker.ts`** (`JunctionBroker`): Thin wrapper
  around the `mosquitto` npm package that boots an embedded Mosquitto
  MQTT broker — primarily for local development and self-contained
  deployments. Parses a single listen URL (`mqtt|mqtts|ws|wss://[user[:pass]@]host[:port]`)
  for protocol/address/port and optional builtin-auth credentials, and
  bridges Mosquitto's stdout/stderr into pino.
  Constructor: `new JunctionBroker(listenUrl, options)`.

- **`src/junction-api-orchestrator.ts`** (`JunctionOrchestrator`): A
  two-pass supervisor that reads a YAML config, renders Nunjucks
  templates from `src/templates/` into a *run directory*, then spawns and
  supervises the whole topology. Pass 1 generates router (HAProxy or
  nftables), reverse-proxy (HAProxy), Mosquitto broker configs + ACL +
  password files, and a server key/cert bundle — for `self-signed` TLS a
  CA + server pair via `selfsigned`, for `lets-encrypt` TLS a CA-signed
  pair acquired via `src/junction-api-acme.ts`. Both TLS types end up in
  the same combined `proxy-sv.pem` (leaf + chain + key) that HAProxy
  loads. Pass 2 spawns `mosquitto`, `haproxy`, and
  `junction frontend` child processes (skipped under `--dry-run`),
  capturing their stdout/stderr into pino and terminating them on
  shutdown. For the `nftables` router type, pass 2 additionally applies
  the generated `router-nftables.conf` once via `nft -f` (a one-shot
  kernel load, not a supervised child) — this needs the orchestrator to
  run as **root** with `CAP_NET_ADMIN`, and (when containerized) under
  host networking, e.g. `docker run --network=host --cap-add=NET_ADMIN`,
  so the DNAT rules affect host traffic; a non-root run is warned about
  and will likely fail. The `haproxy` router type, by contrast, is a
  plain userspace child needing no special privileges.
  Constructor: `new JunctionOrchestrator(configFile, options)`.
  For `lets-encrypt` TLS it additionally owns a `JunctionAcme` facility
  (`src/junction-api-acme.ts`, built on `@certd/acme-client`) which binds
  a Hapi *HTTP-01* challenge service on `proxy.tls.addr:proxy.tls.port`
  for the orchestrator's whole lifetime — the port the router DNATs
  port 80 to — and a daily renewal timer that re-orders below 30 days of
  remaining validity and hot-loads the new bundle into every running
  HAProxy through its `proxy-NN.sock` admin socket. An optional
  `proxy.tls.staging` selects the Let's Encrypt staging directory.
  Config is loaded via `@dotenvx/dotenvx` (`.env`, optionally overlaid
  with `--env-file`), parsed with `js-yaml`, schema-validated with
  `valibot`, and supports `JUNCTION_*` environment-variable overrides
  (`JUNCTION_XX_YY` → `xx.yy`, numeric segments index arrays, only
  pre-existing scalar leaves are overwritten).

- **`src/junction-cli.ts`**: Single CLI entry point built on
  `commander`. Defines the top-level `junction` program with four
  sub-commands: `junction frontend`, `junction backend`, `junction
  broker`, `junction orchestrator`. Each sub-command is configured by a
  `configureCommand(program)` export from
  `src/junction-cli-{frontend,backend,broker,orchestrator}.ts`. Frontend
  and backend accept `-c/--connect <url>`, `-L/--log-level`,
  `-T/--timeout` (MQTT+ request timeout, ms, default 4000), `-C/--codec`
  (`json`|`cbor`, default `json`). Frontend additionally takes
  `-l/--listen <url>`; backend takes `-d/--directory <path>` and
  repeatable `-e/--exclude <glob>`. Broker takes `-l/--listen <mqtt-url>`
  and `-L/--log-level`. Orchestrator takes mandatory `-c/--config <file>`
  plus `-e/--env-file <file>`, `-d/--directory <dir>` (run dir),
  `-p/--prune`, `-n/--dry-run`, and `-L/--log-level`.

- **`src/junction-api.ts`**: Library entry point that re-exports all four
  API classes (used when consumed as `@rse/junction` package).

- **`src/templates/`**: Nunjucks templates rendered by the orchestrator —
  `router-haproxy.conf.njk`, `router-nftables.conf.njk`, `proxy.conf.njk`,
  `broker-{frontend,backend}.conf.njk`, and
  `broker-{frontend,backend}-acl.txt.njk`. Rendered with
  `@rse/nunjucks-addons` and `autoescape: false`.

- **`src/container/`**: Docker assets — `junction.dockerfile`,
  `junction-haproxy.dockerfile`, `junction-mosquitto.dockerfile` (plus a
  Mosquitto patch and an `rc.bash`). Built/pushed via the `package` /
  `publish` stx targets.

- **`etc/junction-local.yaml`**, **`etc/junction-server.yaml`**: example
  orchestrator configurations (local development vs. server deployment).

### MQTT+ transport contract

Communication uses the package `mqtt-plus`. Both sides must agree on the
same `topicMake`/`topicMatch` scheme and codec/timeout:

- The connect URL is split into three independent parts: the URL's
  `username`/`password` are stripped and passed to `MQTT.connect`
  separately; the URL's **pathname** is passed as the MQTT `path` option
  (the WebSocket request path, for `ws`/`wss` connects); and an optional
  **`?topic=` search parameter** supplies the **topic namespace prefix**
  (e.g. `wss://.../pr/api/client/?topic=example` → topics under
  `example/...`). When `?topic=` is absent the prefix is empty.

- Topic shape: `<prefix>/<name>/<protocol>/<peerId|"any">`. The same
  prefix-escaping and regex are constructed identically in both API files
  — keep them in sync if you change the scheme.

- The API `type API = { "frontend/refresh": Service<...>,
  "frontend/delete": Service<...>, "backend/fetch": Source<...> }` is
  duplicated in both files and must stay identical.

- The frontend uses `mqttp.fetch("backend/fetch", path)` to retrieve a
  streamed body plus `meta` (`path`, `type`, `modified`, optional `ttl`,
  optional `headers`). TTL drives the LRU cache entry expiry; `path` is
  the backend-resolved canonical key.

- Both API classes give `MQTT.connect` an explicit `clientId`
  (`junction-{frontend,backend}-<nanoid>`), which MQTT+ reuses as its
  peer id. The initial connect is awaited against `options.timeout`;
  afterwards, persistent listeners log `reconnect`/`connect`/`offline`/
  `close`/`disconnect`/`error` so broker connection churn is observable.

### Service lifecycle

All four API classes (`JunctionFrontend`, `JunctionBackend`,
`JunctionBroker`, `JunctionOrchestrator`) follow the same lifecycle
pattern:

- A private `started: boolean` flag guards `start()` and `stop()`:
  `start()` throws if already started, `stop()` throws if not started,
  and the flag is set/cleared at the end of each respectively.

- Long-lived resources (`mqtt`, `mqttp`, `hapi`, `watcher`, `mosquitto`,
  `children`, `runDir`, `config`, `env`) are typed `T | null` on the
  class, initialized to `null`, assigned in `start()`, and set back to
  `null` in `stop()` after teardown. Inside `start()`, prefer capturing
  the freshly constructed value into a `const` local and reusing that
  local within the same scope — this avoids `this.x!`/`this.x?` noise.
  The `logger` field is the exception: it is declared with a
  definite-assignment assertion (`private logger!: Logger`) since the
  `started` guard already enforces the "logger present before use"
  invariant.

### Logging

All services use `pino` with `pino-pretty` transport and a shared level
(`error|warn|info|debug`). MQTT, MQTT+, Mosquitto stdout/stderr, and the
orchestrator's spawned child processes are bridged into pino — when
adding log messages, follow the existing `key: "value"` style (e.g.
`cache: REFRESH: path: "..."`).

## Code style (project-specific)

The repo follows a distinctive style — when editing, match it rather than reformatting:

- No semicolons except inside `for(...)`.
- Single-statement `if`/`while` bodies have no braces.
- Option objects and type members are vertically aligned on the colon (see `Options` types and the commander option blocks in `src/junction-cli-*.ts`).
- Imports are vertically aligned (`import X           from "..."`).
- Block comments use the `/*  ...  */` form with two leading/trailing spaces.
- The MIT license header is prepended to every `src/*.ts` file — preserve it when editing.

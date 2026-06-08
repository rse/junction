
# AGENTS.md

This file provides guidance to Agentic AI Coding tools when working with code in this repository.

## Build, Lint, Run

The build orchestrator is `stx` (config: `etc/stx.conf`). The single npm
script `npm start` delegates to it. Run targets as `npm start <target>`:

- `npm start lint`     — ESLint over `src/*.ts` (config `etc/eslint.mts`)
- `npm start build`    — runs `lint`, then `tsc --project etc/tsc.json` (emits to `dst/`)
- `npm start clean`    — remove `dst/`
- `npm start frontend` — `node dst/junction-cli.js frontend`
- `npm start backend`  — `node dst/junction-cli.js backend`
- `npm start broker`   — `node dst/junction-cli.js broker` (bundled Mosquitto MQTT broker)
- `npm start package` / `publish` — Docker image build/push (host-gated to `en4.*`)

There is no test suite. A typical local dev loop is: start the broker,
then the backend (with `-d <dir>`), then the frontend (with `-l <url>`),
all pointing at the same `mqtt://...` URL.

## Architecture

Junction is an **HTTP/REST-over-MQTT gateway** that exposes a filesystem
directory to HTTP clients through an MQTT broker. The system is
intentionally split into three independently runnable processes:

```
HTTP client → [frontend] →(MQTT)→ broker →(MQTT)→ [backend] → filesystem
```

- **`src/junction-api-frontend.ts`** (`JunctionFrontend`): Hapi HTTP
  server with an in-memory `lru-cache` of fetched assets. On a request
  miss, it `fetch`es the resource over MQTT+ from any backend. It also
  exposes two MQTT+ *services* (`frontend/refresh`, `frontend/delete`)
  that backends call when files change, so caches stay coherent. Supports
  `If-Modified-Since` / `304`.

- **`src/junction-api-backend.ts`** (`JunctionBackend`): Watches a
  directory with `chokidar` and exposes a `backend/fetch` MQTT+ *source*
  that streams file contents with `{ type, modified }` meta. MIME type is
  detected via `file-type` then `mime-types`. Directory and `index.html`
  fallback are handled here, plus a path-traversal guard against escaping
  the served root.

- **`src/junction-api-broker.ts`** (`JunctionBroker`): Thin wrapper
  around the `mosquitto` npm package that boots an embedded Mosquitto
  MQTT broker — primarily for local development and self-contained
  deployments. Parses a single listen URL (`mqtt|mqtts|ws|wss://[user[:pass]@]host[:port]`)
  for protocol/address/port and optional builtin-auth credentials, and
  bridges Mosquitto's stdout/stderr into pino.

- **`src/junction-cli.ts`**: Single CLI entry point built on
  `commander`. Defines the top-level `junction` program with three
  sub-commands: `junction frontend`, `junction backend`, `junction broker`.
  Each sub-command is configured by a `configureCommand(program)` export
  from `src/junction-cli-{frontend,backend,broker}.ts`. Frontend and
  backend accept `-c/--connect <mqtt-url>`, `-L/--log-level`,
  `-T/--timeout` (MQTT+ request timeout, ms), `-C/--codec`
  (`json`|`cbor`). Frontend additionally takes `-l/--listen`; backend
  takes `-d/--directory` and repeatable `-e/--exclude` globs. Broker
  takes `-l/--listen <mqtt-url>` and `-L/--log-level`.

- **`src/junction-api.ts`**: Library entry point that re-exports all three
  API classes (used when consumed as `@rse/junction` package).

### MQTT+ transport contract

Communication uses the package `mqtt-plus`. Both sides must agree on the
same `topicMake`/`topicMatch` scheme and codec/timeout:

- The MQTT connect URL's pathname is the **topic namespace prefix**
  (e.g. `mqtt://.../example` → topics under `example/...`). The URL's
  `username`/`password` are stripped and passed to `MQTT.connect`
  separately.

- Topic shape: `<prefix>/<name>/<protocol>/<peerId|"any">`. The same
  regex is constructed identically in both API files — keep them in sync
  if you change the scheme.

- The API `type API = { "frontend/refresh": Service<...>,
  "frontend/delete": Service<...>, "backend/fetch": Source<...> }` is
  duplicated in both files and must stay identical.

- The frontend uses `mqttp.fetch("backend/fetch", path)` to retrieve a
  streamed body plus `meta` (`type`, `modified`, optional `ttl`, optional
  `headers`). TTL drives the LRU cache entry expiry.

### Service lifecycle

All three API classes (`JunctionFrontend`, `JunctionBackend`,
`JunctionBroker`) follow the same lifecycle pattern:

- A private `started: boolean` flag guards `start()` and `stop()`:
  `start()` throws if already started, `stop()` throws if not started,
  and the flag is set/cleared at the end of each respectively.

- Long-lived resources (`mqtt`, `mqttp`, `hapi`, `watcher`, `mosquitto`)
  are typed `T | null` on the class, initialized to `null`, assigned in
  `start()`, and set back to `null` in `stop()` after teardown. Inside
  `start()`, prefer capturing the freshly constructed value into a
  `const` local and reusing that local within the same scope — this
  avoids `this.x!`/`this.x?` noise. The `logger` field is the
  exception: it is declared with a definite-assignment assertion
  (`private logger!: Logger`) since the `started` guard already enforces
  the "logger present before use" invariant.

### Logging

All services use `pino` with `pino-pretty` transport and a shared level
(`error|warn|info|debug`). MQTT, MQTT+, and Mosquitto stdout/stderr are
bridged into pino — when adding log messages, follow the existing
`key: "value"` style (e.g. `cache: REFRESH: path: "..."`).

## Code style (project-specific)

The repo follows a distinctive style — when editing, match it rather than reformatting:

- No semicolons except inside `for(...)`.
- Single-statement `if`/`while` bodies have no braces.
- Option objects and type members are vertically aligned on the colon (see `Options` types and the commander option blocks in `src/junction-cli-*.ts`).
- Imports are vertically aligned (`import X           from "..."`).
- Block comments use the `/*  ...  */` form with two leading/trailing spaces.
- The MIT license header is prepended to every `src/*.ts` file — preserve it when editing.


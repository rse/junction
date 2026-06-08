
Junction
========

HTTP/REST over [MQTT](http://mqtt.org/) Gateway

[![NPM](https://nodei.co/npm/@rse/junction.svg?downloads=true&stars=true)](https://nodei.co/npm/@rse/junction/)

[![github (author stars)](https://img.shields.io/github/stars/rse?logo=github&label=author%20stars&color=%233377aa)](https://github.com/rse)
[![github (author followers)](https://img.shields.io/github/followers/rse?label=author%20followers&logo=github&color=%234477aa)](https://github.com/rse)

About
-----

**Junction** is a TypeScript/JavaScript based **HTTP/REST-over-MQTT
gateway** that exposes a local filesystem directory to HTTP clients
through an [MQTT](http://mqtt.org/) broker. It is intentionally split
into three independently runnable processes &mdash; a *frontend* (the HTTP
ingress), a *backend* (the filesystem egress), and an optional embedded
*broker* — which all communicate over [MQTT](http://mqtt.org/) using the
typed higher-level communication patterns of
[MQTT+](https://npmjs.com/mqtt-plus). For full deployments there is also
an optional *orchestrator* that generates all configuration files and
spawns and supervises an entire [HAProxy](https://www.haproxy.org/) +
[Mosquitto](https://mosquitto.org/) + frontend topology from a single
YAML configuration.

```txt
HTTP client -→ [frontend] -→MQTT-→ [broker] -→MQTT-→ [backend] -→ filesystem
```

The *frontend* is HTTP server with an in-memory
[LRU](https://npmjs.com/lru-cache) cache of fetched assets. On a cache
miss it fetches the resource over [MQTT+](https://npmjs.com/mqtt-plus)
from any available *backend*. The *backend* watches a directory,
serves file contents through an [MQTT+](https://npmjs.com/mqtt-plus)
*source*, and proactively notifies *frontends* of changes so caches stay
coherent. MIME type detection, directory and `index.html` fallback,
`If-Modified-Since`/`304` support, and a path-traversal guard are all
built in.

The result is a robust, scalable, and decoupled way to serve static
filesystem content to HTTP clients through an [MQTT](http://mqtt.org/)
fabric &mdash; particularly suited for systems with a [*Hub &
Spoke*](https://en.wikipedia.org/wiki/Spoke%E2%80%93hub_distribution_par
adigm) communication architecture, where the HTTP ingress and the
content origin are separated by an [MQTT](http://mqtt.org/) message bus.

Installation
------------

**Junction** is published as a Node Package Manager (NPM) package named
[`@rse/junction`](https://npmjs.com/@rse/junction). Install it with the
help of the NPM Command-Line Interface (CLI):

```shell
$ npm install @rse/junction
```

This provides a single command-line tool `junction` with the four
sub-commands `junction frontend`, `junction backend`, `junction broker`,
and `junction orchestrator`, as well as a library entry point exporting
the four API classes for embedding into own applications.

Usage
-----

### Command-Line Interface (CLI)

A typical local development loop consists of three processes, all
pointing at the same [MQTT](http://mqtt.org/) URL. In the connect URL the
`username`/`password` act as the [MQTT](http://mqtt.org/) credentials,
the pathname is the connection path (the WebSocket request path for
`ws`/`wss` connects), and an optional `?topic=<prefix>` search parameter
selects the [MQTT+](https://npmjs.com/mqtt-plus) topic namespace prefix.

Start the embedded [Mosquitto](https://mosquitto.org/) broker:

```shell
$ junction broker \
    -l mqtt://user:pass@127.0.0.1:1883
```

Start a backend exposing a directory:

```shell
$ junction backend \
    -c "mqtt://user:pass@127.0.0.1:1883/?topic=example" \
    -d ./htdocs \
    -e "**/*.bak"
```

Start a frontend exposing an HTTP listener:

```shell
$ junction frontend \
    -c "mqtt://user:pass@127.0.0.1:1883/?topic=example" \
    -l http://0.0.0.0:8080
```

Both `frontend` and `backend` additionally accept `-L/--log-level`
(`error`|`warn`|`info`|`debug`), `-T/--timeout` (MQTT+ request timeout in
milliseconds), and `-C/--codec` (`json`|`cbor`).

### Orchestrator

For a complete, production-style topology, the `orchestrator` sub-command
reads a single YAML configuration, generates all
[HAProxy](https://www.haproxy.org/) and
[Mosquitto](https://mosquitto.org/) configuration files (plus, for
self-signed TLS, a CA and server certificate), and then spawns and
supervises the whole router + reverse-proxy + broker + frontend topology:

```shell
$ junction orchestrator \
    -c ./junction.yaml \
    -d ./run \
    -p
```

It accepts `-c/--config <file>` (mandatory), `-e/--env-file <file>` (an
additional `.env` file overlaid onto the current directory's `.env`),
`-d/--directory <dir>` (target run directory; an auto-removed temporary
directory is used when omitted), `-p/--prune` (clear the run directory
first), `-n/--dry-run` (generate config files only; do not spawn
processes), and `-L/--log-level`. Scalar configuration leaves can be
overridden via `JUNCTION_*` environment variables (e.g.
`JUNCTION_PROXY_INSTANCES=4` overrides `proxy.instances`). See
`etc/junction-local.yaml` and `etc/junction-server.yaml` for example
configurations.

### Application Programming Interface (API)

**Junction** can also be embedded as a library. The package exports
the four API classes `JunctionBroker`, `JunctionBackend`,
`JunctionFrontend`, and `JunctionOrchestrator`, all of which follow the
same `start()`/`stop()` lifecycle pattern. The connection-related
arguments are passed positionally, followed by a final `options` object:

```ts
import {
    JunctionBroker,
    JunctionBackend,
    JunctionFrontend,
    JunctionOrchestrator
} from "@rse/junction"
```

```ts
/*  broker (optional): new JunctionBroker(listenUrl, options)  */
const broker = new JunctionBroker(
    "mqtt://user:pass@127.0.0.1:1883",
    { logLevel: "info" }
)
await broker.start()
```

```ts
/*  backend (filesystem → MQTT+): new JunctionBackend(directory, connectUrl, options)  */
const backend = new JunctionBackend(
    "./htdocs",
    "mqtt://user:pass@127.0.0.1:1883/?topic=example",
    {
        exclude:  [ "**/*.bak" ],
        codec:    "cbor",
        timeout:  5000,
        logLevel: "info"
    }
)
await backend.start()
```

```ts
/*  frontend (HTTP → MQTT+): new JunctionFrontend(listenUrl, connectUrl, options)  */
const frontend = new JunctionFrontend(
    "http://0.0.0.0:8080",
    "mqtt://user:pass@127.0.0.1:1883/?topic=example",
    {
        codec:    "cbor",
        timeout:  5000,
        logLevel: "info"
    }
)
await frontend.start()
```

```ts
/*  orchestrator (full topology): new JunctionOrchestrator(configFile, options)  */
const orchestrator = new JunctionOrchestrator(
    "./junction.yaml",
    {
        envFile:   undefined,
        directory: "./run",
        prune:     true,
        dryRun:    false,
        logLevel:  "info"
    }
)
await orchestrator.start()
```

License
-------

Copyright &copy; 2025-2026 Dr. Ralf S. Engelschall (http://engelschall.com/)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


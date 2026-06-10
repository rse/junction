/*
**  Junction -- HTTP/REST over MQTT Gateway
**  Copyright (c) 2025-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**
**  Permission is hereby granted, free of charge, to any person obtaining
**  a copy of this software and associated documentation files (the
**  "Software"), to deal in the Software without restriction, including
**  without limitation the rights to use, copy, modify, merge, publish,
**  distribute, sublicense, and/or sell copies of the Software, and to
**  permit persons to whom the Software is furnished to do so, subject to
**  the following conditions:
**
**  The above copyright notice and this permission notice shall be included
**  in all copies or substantial portions of the Software.
**
**  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
**  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
**  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
**  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
**  CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
**  TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
**  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

/*  external dependencies  */
import Hapi                       from "@hapi/hapi"
import { LRUCache }               from "lru-cache"
import MQTT, { MqttClient }       from "mqtt"
import MQTTp                      from "mqtt-plus"
import type { Service, Source }   from "mqtt-plus"
import pino                       from "pino"
import type { Logger }            from "pino"
import { DateTime }               from "luxon"
import { nanoid }                 from "nanoid"

/*  cache entry type  */
interface Asset {
    path?:     string
    content:   Buffer
    type?:     string
    modified?: number
    ttl?:      number
    headers?:  Record<string, string>
}

/*  MQTT API type  */
type API = {
    "frontend/refresh": Service<(path: string) => Promise<boolean>>,
    "frontend/delete":  Service<(path: string) => Promise<boolean>>,
    "backend/fetch":    Source<(path: string)  => Promise<void>>
}

/*  service options  */
type LogLevel = "debug" | "info" | "warn" | "error"
type Options = {
    httpUrl:  string
    mqttUrl?: string
    mqtt?:    MqttClient
    topic?:   string
    logLevel: LogLevel
    timeout:  number
    codec:    "json" | "cbor"
}

/*  service  */
export class JunctionFrontend {
    /*  internal state  */
    private cache = new LRUCache<string, Asset>({
        max:             1000,
        maxSize:         50 * 1024 * 1024,
        sizeCalculation: (entry) => Math.max(1, entry.content.byteLength)
    })
    private hapi:     Hapi.Server | null = null
    private mqtt:     MqttClient  | null = null
    private mqttp:    MQTTp<API>  | null = null
    private logger!:  Logger
    private started:  boolean            = false
    private ownsMqtt: boolean            = false

    /*  API construction  */
    constructor (
        private options: Options
    ) {}

    /*  start service  */
    async start () {
        /*  sanity check state  */
        if (this.started)
            throw new Error("service already started")

        /*  sanity check MQTT connection options (mutually exclusive)  */
        const mqttUrl  = this.options.mqttUrl ?? null
        const mqttInst = this.options.mqtt    ?? null
        if ((mqttUrl === null) === (mqttInst === null))
            throw new Error("exactly one of options.mqttUrl and options.mqtt must be provided")

        /*  establish logging facility  */
        this.logger = pino({
            level: this.options.logLevel,
            formatters: {
                level: (label) => ({ level: label.toUpperCase() })
            },
            timestamp: pino.stdTimeFunctions.isoTime,
            transport: {
                target: "pino-pretty",
                options: {
                    colorize:      process.stdout.isTTY,
                    customColors:  "info:blue,warn:yellow,error:red,message:reset",
                    translateTime: "UTC:yyyy-mm-dd HH:MM:ss.l",
                    ignore:        "pid,hostname"
                }
            }
        })
        this.logger.info("starting Junction FRONTEND service")

        /*  establish HTTP/REST service  */
        this.logger.info(`starting HTTP/REST service: "${this.options.httpUrl}"`)
        const url = new URL(this.options.httpUrl)
        const host = url.hostname
        const port = parseInt(url.port ?? "80", 10)
        this.hapi  = Hapi.server({ port, host, routes: { cors: true } })

        /*  load resource via MQTT from backend  */
        const loadResource = async (path: string): Promise<Asset | undefined> => {
            if (this.mqttp === null)
                return undefined
            const response = await this.mqttp.fetch("backend/fetch", path).catch(() => undefined)
            if (response === undefined)
                return undefined
            const [ data, meta ] = await Promise.all([ response.buffer, response.meta ])
            const content  = Buffer.from(data)
            const path2    = meta?.["path"]     ?? undefined
            const type     = meta?.["type"]     ?? "application/octet-stream"
            const modified = meta?.["modified"] ?? undefined
            const ttl      = meta?.["ttl"]      ?? 60 * 60 * 1000
            const headers  = meta?.["headers"]  ?? undefined
            return { path: path2, content, type, modified, ttl, headers }
        }

        /*  generate HTTP response  */
        const makeResponse = (
            h:         Hapi.ResponseToolkit<Hapi.ReqRefDefaults>,
            content:   Buffer,
            type?:     string,
            modified?: number,
            ttl?:      number,
            headers?:  Record<string, string>,
            cache?:    string
        ) => {
            const response = h.response(content)
            if (type)     response.type(type)
            if (modified) response.header("Last-Modified", DateTime.fromMillis(modified, { zone: "utc" }).toHTTP()!)
            if (ttl)      response.ttl(ttl)
            if (headers)  Object.entries(headers).forEach(([ key, value ]) => response.header(key, value))
            if (cache)    response.header("X-Cache", cache)
            return response
        }

        /*  configure HTTP/REST route  */
        this.hapi.route({
            method:  "GET",
            path:    `${url.pathname ?? "/"}{path*}`,
            handler: async (request, h) => {
                const path = request.params.path
                try {
                    /*  try to fetch asset from cache  */
                    let asset = this.cache.get(path)
                    const cache = asset ? "HIT" : "MISS"

                    /*  if asset is still not cached, load asset from backend  */
                    if (asset === undefined) {
                        /*  load asset from backend  */
                        asset = await loadResource(path)
                        if (asset === undefined) {
                            this.logger.warn(`HTTP/REST request: path: "${path}", ` +
                                `cache: ${cache}, response: 404 (not found)`)
                            return h.response({ error: "Not Found" }).code(404)
                        }

                        /*  cache asset from backend under the canonical path
                            the backend resolved it to (e.g. "" -> "index.html"),
                            so cache-coherence events from the backend, which
                            carry the canonical path, can invalidate it again;
                            additionally alias it under the originally requested
                            path so repeat identical requests still hit the cache  */
                        const key = asset.path ?? path
                        this.cache.set(key, asset, { ttl: asset.ttl })
                        if (key !== path)
                            this.cache.set(path, asset, { ttl: asset.ttl })
                    }

                    /*  support HTTP "If-Modified-Since" header  */
                    const ifModifiedSince = Array.isArray(request.headers["if-modified-since"])
                        ? request.headers["if-modified-since"][0]
                        : request.headers["if-modified-since"]
                    if (ifModifiedSince && asset.modified) {
                        const ifModifiedSinceMs = DateTime.fromHTTP(ifModifiedSince).toMillis()
                        if (ifModifiedSinceMs >= asset.modified) {
                            this.logger.info(`HTTP/REST request: path: "${path}", ` +
                                `cache: ${cache}, response: 304 (not modified)`)
                            return h.response().code(304)
                        }
                    }

                    /*  deliver asset as result  */
                    this.logger.info(`HTTP/REST request: path: "${path}", cache: ${cache}, ` +
                        `response: 200 (found), length: ${asset.content.byteLength}`)
                    return makeResponse(h, asset.content, asset.type,
                        asset.modified, asset.ttl, asset.headers, cache)
                }
                catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err))
                    this.logger.warn(`HTTP/REST request: path: "${path}", ` +
                        `response: 503 (error: ${error.message})`)
                    return h.response({ error: error.message }).code(503)
                }
            }
        })

        /*  start HTTP/REST service  */
        await this.hapi.start()

        /*  establish MQTT service  */
        let mqtt: MqttClient
        let topicPrefix: string
        if (mqttUrl !== null) {
            /*  case 1: connect to MQTT broker via a given URL (we own the client)  */
            const tmp = new URL(mqttUrl)
            tmp.password = ""
            this.logger.info(`starting MQTT service: "${tmp.toString()}"`)
            const url = new URL(mqttUrl)
            const username = url.username; url.username = ""
            const password = url.password; url.password = ""
            const pathname = url.pathname; url.pathname = ""
            topicPrefix = (url.searchParams.get("topic") ?? this.options.topic ?? "").replace(/^\//, "").replace(/\/$/, "")
            url.search = ""
            mqtt = MQTT.connect(url.href, {
                clientId: `junction-frontend-${nanoid()}`,
                path: pathname,
                ...(username !== undefined && username !== "" ? { username } : {}),
                ...(password !== undefined && password !== "" ? { password } : {}),
                rejectUnauthorized: false,
                wsOptions: { rejectUnauthorized: false },
                log: (...args: any[]) => {
                    if (this.logger.isLevelEnabled("debug")) {
                        const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
                        this.logger.debug(`MQTT: ${msg}`)
                    }
                }
            })
            this.mqtt = mqtt
            this.ownsMqtt = true
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    mqtt.off("error",   onError)
                    mqtt.off("connect", onConnect)
                    mqtt.end(true)
                    reject(new Error(`timeout of ${this.options.timeout}ms while connecting to MQTT broker`))
                }, this.options.timeout)
                const onConnect = () => {
                    clearTimeout(timer)
                    mqtt.off("error", onError)
                    resolve()
                }
                const onError = (err: Error) => {
                    clearTimeout(timer)
                    mqtt.off("connect", onConnect)
                    reject(err)
                }
                mqtt.on("error",   onError)
                mqtt.on("connect", onConnect)
            })
            this.logger.info("connected to MQTT broker")
        }
        else {
            /*  case 2: reuse a pre-connected MQTT client (the caller owns it)  */
            this.logger.info("reusing pre-connected MQTT client")
            mqtt = mqttInst!
            this.mqtt = mqtt
            this.ownsMqtt = false
            topicPrefix = (this.options.topic ?? "").replace(/^\//, "").replace(/\/$/, "")
        }

        /*  observe MQTT broker connection situation  */
        mqtt.on("reconnect", () => {
            this.logger.info("reconnecting to MQTT broker")
        })
        mqtt.on("connect", () => {
            this.logger.info("reconnected to MQTT broker")
        })
        mqtt.on("offline", () => {
            this.logger.warn("disconnected from MQTT broker (now offline)")
        })
        mqtt.on("close", () => {
            this.logger.warn("connection to MQTT broker closed")
        })
        mqtt.on("disconnect", () => {
            this.logger.warn("disconnected from MQTT broker (by broker request)")
        })
        mqtt.on("error", (err: Error) => {
            this.logger.error(`MQTT broker connection error: ${err.message}`)
        })

        /*  enabling MQTT+ facility  */
        this.logger.info("enabling MQTT+ facility")
        const prefix    = topicPrefix === "" ? "" : `${topicPrefix}/`
        const prefixRe  = topicPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const prefixReP = topicPrefix === "" ? "" : `${prefixRe}\\/`
        const topicRe   = new RegExp(`^${prefixReP}(.+)\\/([^/]+)\\/([^/]+)$`)
        const mqttp = new MQTTp<API>(mqtt, {
            timeout: this.options.timeout,
            codec:   this.options.codec,
            topicMake: (name, protocol, peerId) => {
                return `${prefix}${name}/${protocol}/${peerId ?? "any"}`
            },
            topicMatch: (topic) => {
                const m = topic.match(topicRe)
                return m ? {
                    name:      m[1],
                    operation: m[2],
                    peerId:    m[3] === "any" ? undefined : m[3]
                } : null
            }
        })
        this.mqttp = mqttp
        mqttp.on("log", async (log) => {
            const pinoLevel = log.level as LogLevel
            if (this.logger.isLevelEnabled(pinoLevel)) {
                await log.resolve()
                this.logger[pinoLevel](`MQTT+: ${log.msg}`)
            }
        })

        /*  evict a canonical path plus any request-path aliases pointing at it
            (e.g. evicting "index.html" must also drop the "" alias cached for
            a "/" request, whose asset carries path "index.html")  */
        const evictPath = (path: string): boolean => {
            let evicted = false
            for (const [ key, asset ] of this.cache.entries()) {
                if (key === path || asset.path === path) {
                    this.cache.delete(key)
                    evicted = true
                }
            }
            return evicted
        }

        /*  configure MQTT frontend service for backend  */
        mqttp.service("frontend/refresh", async (path: string) => {
            this.logger.info(`cache: REFRESH: path: "${path}"`)
            evictPath(path)
            const resource = await loadResource(path)
            if (resource !== undefined)
                this.cache.set(resource.path ?? path, resource, { ttl: resource.ttl })
            return true
        })
        mqttp.service("frontend/delete", async (path: string) => {
            this.logger.info(`cache: DELETE: path: "${path}"`)
            return evictPath(path)
        })

        /*  update state  */
        this.started = true
    }

    /*  stop service  */
    async stop () {
        /*  sanity check state  */
        if (!this.started)
            throw new Error("service not started")

        /*  stop HTTP/REST service  */
        if (this.hapi !== null) {
            this.logger.info("stopping HTTP/REST service")
            await this.hapi.stop()
            this.hapi = null
        }

        /*  stop MQTT+ service  */
        if (this.mqttp !== null) {
            this.logger.info("stopping MQTT+ service")
            this.mqttp.destroy()
            this.mqttp = null
        }

        /*  stop MQTT service (but only if we own the client)  */
        if (this.mqtt !== null) {
            if (this.ownsMqtt) {
                this.logger.info("stopping MQTT service")
                this.mqtt.end()
            }
            this.mqtt = null
        }

        /*  update state  */
        this.started = false
    }
}


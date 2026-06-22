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

/*  built-in dependencies  */
import fs                         from "fs"
import path                       from "path"
import { Readable }               from "stream"

/*  external dependencies  */
import MQTT, { MqttClient }       from "mqtt"
import MQTTp                      from "mqtt-plus"
import type { Service, Source }   from "mqtt-plus"
import chokidar                   from "chokidar"
import type { FSWatcher }         from "chokidar"
import { lookup }                 from "mime-types"
import { fileTypeFromFile }       from "file-type"
import { nanoid }                 from "nanoid"

/*  internal dependencies  */
import { makeLogger }             from "./junction-api-logger.js"
import type { JunctionLogger, LogLevel, LogSink } from "./junction-api-logger.js"

/*  MQTT API type  */
type API = {
    "frontend/refresh": Service<(path: string) => Promise<boolean>>,
    "frontend/delete":  Service<(path: string) => Promise<boolean>>,
    "backend/fetch":    Source<(path: string)  => Promise<void>>
}

/*  service options  */
type Options = {
    directory: string
    mqttUrl?:  string
    mqtt?:     MqttClient
    topic?:    string
    logLevel:  LogLevel
    logSink?:  LogSink
    watch:     boolean
    exclude:   string[]
    timeout:   number
    codec:     "json" | "cbor"
}

/*  service  */
export class JunctionBackend {
    private mqtt:     MqttClient | null = null
    private mqttp:    MQTTp<API> | null = null
    private watcher:  FSWatcher  | null = null
    private logger!:  JunctionLogger
    private started:  boolean           = false
    private ownsMqtt: boolean           = false

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
        this.logger = makeLogger(this.options.logLevel, this.options.logSink)
        this.logger.info("starting Junction BACKEND service")

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
                clientId: `junction-backend-${nanoid()}`,
                path: pathname,
                keepalive: 30,
                reconnectPeriod: 1000,
                ...(username !== undefined && username !== "" ? { username } : {}),
                ...(password !== undefined && password !== "" ? { password } : {}),
                rejectUnauthorized: false,
                wsOptions: { rejectUnauthorized: false },
                log: (...args: any[]) => {
                    if (this.logger.isLevelEnabled("debug")) {
                        const msg = args.map((a) =>
                            typeof a === "string" ? a : JSON.stringify(a)
                        ).join(" ")
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
        this.logger.info("enabling MQTT+ service")
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

        /*  watch filesystem  */
        const baseDir = path.normalize(path.resolve(this.options.directory))
        const relPath = (file: string) => {
            const abs = path.normalize(path.resolve(file))
            const rel = path.relative(baseDir, abs)
            return rel.split(path.sep).join("/")
        }
        if (this.options.watch) {
            this.logger.info(`starting filesystem watcher: "${this.options.directory}"`)
            const excludePatterns = this.options.exclude
            this.watcher = chokidar.watch(this.options.directory, {
                awaitWriteFinish: {
                    stabilityThreshold: 1000,
                    pollInterval:       200
                },
                persistent:             true,
                atomic:                 1000,
                alwaysStat:             true,
                interval:               200,
                binaryInterval:         200,
                ignored: [
                    (file: string, stat?: fs.Stats) => {
                        if (file.match(/(?:^~\$|\/~\$|node_modules\/)/) !== null)
                            return true
                        return false
                    },
                    ...excludePatterns
                ]
            })
            if (excludePatterns.length > 0)
                this.logger.info("excluding glob patterns from watching: " +
                    excludePatterns.map((p) => `"${p}"`).join(", "))

            /*  trigger frontend on added files  */
            this.watcher.on("add", async (file: string, stats?: fs.Stats) => {
                const path = relPath(file)
                this.logger.info(`filesystem change: path: "${path}", event: "add"`)
                await this.mqttp?.call("frontend/refresh", path).catch((err) => {
                    this.logger.warn(`MQTT call failed for "frontend/refresh": path: ${path}: ${err}`)
                })
            })

            /*  trigger frontend on modified files  */
            this.watcher.on("change", async (file: string, stats?: fs.Stats) => {
                const path = relPath(file)
                this.logger.info(`filesystem change: path: "${path}", event: "change"`)
                await this.mqttp?.call("frontend/refresh", path).catch((err) => {
                    this.logger.warn(`MQTT call failed for "frontend/refresh": path: ${path}: ${err}`)
                })
            })

            /*  trigger frontend on removed files  */
            this.watcher.on("unlink", async (file: string) => {
                const path = relPath(file)
                this.logger.info(`filesystem change: path: "${path}", event: "unlink"`)
                await this.mqttp?.call("frontend/delete", path).catch((err) => {
                    this.logger.warn(`MQTT call failed for "frontend/delete": path: ${path}: ${err}`)
                })
            })
        }
        else
            this.logger.info("filesystem watching disabled")

        /*  utility function for determine MIME type  */
        const detectMimeType = async (path: string): Promise<string> => {
            const detectedType = await fileTypeFromFile(path)
            if (detectedType)
                return detectedType.mime
            const lookupType = lookup(path)
            if (lookupType !== false)
                return lookupType
            return "application/octet-stream"
        }

        /*  configure MQTT service for frontend  */
        mqttp.source("backend/fetch", async (filePath, info) => {
            /*  determine filesystem segments  */
            let filename = path.normalize(path.resolve(baseDir, filePath))

            /*  ensure request is inside base directory  */
            if (!filename.startsWith(baseDir + path.sep) && filename !== baseDir) {
                this.logger.warn(`access: path: "${filePath}", response: ERROR (outside allowed directory)`)
                throw new Error(`path "${filePath}" is outside allowed directory`)
            }

            /*  determine type of file  */
            let stat = await fs.promises.stat(filename).catch(() => null)

            /*  provide auto-index-like functionality  */
            if (   (stat === null && (filePath === "" || filePath.endsWith("/")))
                || (stat !== null && stat.isDirectory())) {
                filePath = filePath.endsWith("/") || filePath === ""
                    ? `${filePath}index.html`
                    : `${filePath}/index.html`
                filename = path.normalize(path.resolve(baseDir, filePath))
                if (!filename.startsWith(baseDir + path.sep) && filename !== baseDir) {
                    this.logger.warn(`access: path: "${filePath}", response: ERROR (outside allowed directory)`)
                    throw new Error(`path "${filePath}" is outside allowed directory`)
                }
                stat = await fs.promises.stat(filename).catch(() => null)
            }

            /*  sanity check file  */
            if (stat === null) {
                this.logger.warn(`access: path: "${filePath}", response: ERROR (not found)`)
                throw new Error(`path "${filePath}" not found`)
            }
            if (!stat.isFile()) {
                this.logger.warn(`access: path: "${filePath}", response: ERROR (not a file)`)
                throw new Error(`path "${filePath}" not a regular file`)
            }

            /*  determine mime type  */
            const type = await detectMimeType(filename)

            /*  create readable stream for file  */
            let readable: Readable
            try {
                readable = fs.createReadStream(filename)
            }
            catch (err) {
                const error = err instanceof Error ? err.message : String(err)
                this.logger.warn(`access: path: "${filePath}", response: ERROR (not readable: ${error})`)
                throw new Error(`path "${filePath}" not readable: ${error}`)
            }

            /*  provide results to MQTT+ facility  */
            this.logger.info(`access: path: "${filePath}", response: OK (bytes: ${stat.size}, type: "${type}")`)
            info.stream = readable
            info.meta = {}
            info.meta.path = filePath
            info.meta.type = type
            info.meta.modified = stat.mtimeMs
        })

        /*  update state  */
        this.started = true
    }

    /*  stop service  */
    async stop () {
        /*  sanity check state  */
        if (!this.started)
            throw new Error("service not started")

        /*  stop filesystem watcher  */
        if (this.watcher !== null) {
            this.logger.info("stopping Filesystem watcher")
            this.watcher.close()
            this.watcher = null
        }

        /*  stop MQTT+ service  */
        if (this.mqttp !== null) {
            this.logger.info("stopping MQTT+ service")
            await this.mqttp.destroy()
            this.mqttp = null
        }

        /*  stop MQTT service (but only if we own the client)  */
        if (this.mqtt !== null) {
            if (this.ownsMqtt) {
                this.logger.info("stopping MQTT service")
                await this.mqtt.endAsync(true)
            }
            this.mqtt = null
        }

        /*  update state  */
        this.started = false
    }
}


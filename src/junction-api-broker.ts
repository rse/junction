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
import Mosquitto                 from "mosquitto"
import pino                      from "pino"
import type { Logger }           from "pino"

/*  service options  */
type LogLevel = "debug" | "info" | "warn" | "error"
type Options = {
    logLevel: LogLevel
}

/*  service  */
export class JunctionBroker {
    private mosquitto: Mosquitto | null = null
    private logger!:   Logger
    private started:   boolean          = false

    /*  API construction  */
    constructor (
        private listenUrl: string,
        private options:   Options
    ) {}

    /*  start service  */
    async start () {
        /*  sanity check state  */
        if (this.started)
            throw new Error("service already started")

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
        this.logger.info("starting Junction BROKER service")

        /*  parse listen URL for protocol/host/port and optional credentials  */
        const url = new URL(this.listenUrl)
        const protocol = url.protocol.replace(/:$/, "") as "mqtt" | "mqtts" | "ws" | "wss"
        if (protocol !== "mqtt" && protocol !== "mqtts" && protocol !== "ws" && protocol !== "wss")
            throw new Error(`unsupported listen protocol: "${protocol}"`)
        const address  = url.hostname
        const port     = parseInt(url.port !== "" ? url.port : "1883", 10)
        const username = url.username !== "" ? decodeURIComponent(url.username) : ""
        const password = url.password !== "" ? decodeURIComponent(url.password) : ""

        /*  log without credentials  */
        const tmp = new URL(this.listenUrl)
        tmp.password = ""
        this.logger.info(`starting Mosquitto MQTT broker: "${tmp.toString()}"`)

        /*  establish Mosquitto broker  */
        const mosquitto = new Mosquitto({
            debug:  this.logger.isLevelEnabled("debug"),
            listen: [ { protocol, address, port } ],
            auth:   "builtin",
            passwd: username !== "" ? [ { username, password } ] : []
        })
        this.mosquitto = mosquitto

        /*  pass-through Mosquitto outputs  */
        if (this.logger.isLevelEnabled("info")) {
            mosquitto.on("stdout", (data: Buffer | string) => {
                const msgs = (typeof data === "string" ? data : data.toString()).split(/\r?\n/)
                for (let msg of msgs) {
                    msg = msg.replace(/^\[.+?\]:\s+/, "")
                    if (msg !== "")
                        this.logger.info(msg)
                }
            })
            mosquitto.on("stderr", (data: Buffer | string) => {
                const msgs = (typeof data === "string" ? data : data.toString()).split(/\r?\n/)
                for (let msg of msgs) {
                    msg = msg.replace(/^\[.+?\]:\s+/, "")
                    if (msg !== "")
                        this.logger.info(msg)
                }
            })
        }

        /*  start Mosquitto broker  */
        await mosquitto.start()

        /*  update state  */
        this.started = true
    }

    /*  stop service  */
    async stop () {
        /*  sanity check state  */
        if (!this.started)
            throw new Error("service not started")

        /*  stop Mosquitto broker  */
        if (this.mosquitto !== null) {
            this.logger.info("stopping Mosquitto MQTT broker")
            await this.mosquitto.stop()
            this.mosquitto = null
        }

        /*  update state  */
        this.started = false
    }
}


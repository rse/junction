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
import { Command, Option } from "commander"

/*  internal dependencies  */
import { JunctionBackend } from "./junction-api-backend.js"

/*  option value types  */
type LogLevel = "error" | "warn" | "info" | "debug"
type Codec    = "json"  | "cbor"
type Opts = {
    directory: string
    connect:   string
    watch:     boolean
    exclude:   string[]
    logLevel:  LogLevel
    timeout:   number
    codec:     Codec
    share?:    string
}

/*  configure a commander sub-command for the backend service  */
export function configureCommand (program: Command): Command {
    return program
        .description("Filesystem backend service")
        .addOption(new Option("-d, --directory <path>",
            "Filesystem directory path")
            .default("."))
        .addOption(new Option("-c, --connect <url>",
            "TCP/MQTT connect URL")
            .default("mqtt://example:example@127.0.0.1:1883/example"))
        .addOption(new Option("--no-watch",
            "Disable filesystem watching entirely"))
        .addOption(new Option("-e, --exclude <glob>",
            "Glob pattern to exclude from directory watching (repeatable)")
            .argParser((value: string, prev: string[]) => prev.concat(value))
            .default([] as string[]))
        .addOption(new Option("-L, --log-level <level>",
            "Logging level").choices([ "error", "warn", "info", "debug" ])
            .default("info"))
        .addOption(new Option("-T, --timeout <ms>",
            "MQTT+ request timeout in milliseconds")
            .argParser((v: string) => parseInt(v, 10))
            .default(4000))
        .addOption(new Option("-C, --codec <codec>",
            "MQTT+ payload codec")
            .choices([ "json", "cbor" ])
            .default("json"))
        .addOption(new Option("-s, --share <group>",
            "MQTT5 shared-subscription group for load-balancing fetch requests across a backend cluster"))
        .action(async (opts: Opts) => {
            /*  establish service  */
            const service = new JunctionBackend({
                directory: opts.directory,
                mqttUrl:   opts.connect,
                logLevel:  opts.logLevel,
                watch:     opts.watch,
                exclude:   opts.exclude,
                timeout:   opts.timeout,
                codec:     opts.codec,
                share:     opts.share
            })
            await service.start()

            /*  handle graceful shutdown  */
            const shutdown = async () => {
                await service.stop()
                process.exit(0)
            }
            process.on("SIGINT",  shutdown)
            process.on("SIGTERM", shutdown)
        })
}


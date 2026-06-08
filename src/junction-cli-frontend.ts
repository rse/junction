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
import JunctionFrontend    from "./junction-api-frontend.js"

/*  option value types  */
type LogLevel = "error" | "warn" | "info" | "debug"
type Codec    = "json"  | "cbor"
type Opts = {
    listen:   string
    connect:  string
    logLevel: LogLevel
    timeout:  number
    codec:    Codec
}

/*  configure a commander sub-command for the frontend service  */
export function configureCommand (program: Command): Command {
    return program
        .description("HTTP/REST frontend service")
        .addOption(new Option("-l, --listen <url>",
            "HTTP/REST listen URL")
            .default("http://127.0.0.1:1234/example/"))
        .addOption(new Option("-c, --connect <url>",
            "TCP/MQTT connect URL")
            .default("mqtt://example:example@127.0.0.1:1883/example"))
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
        .action(async (opts: Opts) => {
            /*  establish service  */
            const service = new JunctionFrontend(opts.listen, opts.connect, {
                logLevel: opts.logLevel,
                timeout:  opts.timeout,
                codec:    opts.codec
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

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
import JunctionBroker      from "./junction-api-broker.js"

/*  option value types  */
type LogLevel = "error" | "warn" | "info" | "debug"
type Opts = {
    listen:   string
    logLevel: LogLevel
}

/*  configure a commander sub-command for the broker service  */
export function configureCommand (program: Command): Command {
    return program
        .description("Embedded MQTT broker service")
        .addOption(new Option("-l, --listen <url>",
            "MQTT broker listen URL")
            .default("mqtt://example:example@127.0.0.1:1883"))
        .addOption(new Option("-L, --log-level <level>",
            "Logging level").choices([ "error", "warn", "info", "debug" ])
            .default("info"))
        .action(async (opts: Opts) => {
            /*  establish service  */
            const service = new JunctionBroker(opts.listen, {
                logLevel: opts.logLevel
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

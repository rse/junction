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
import { Command, Option }      from "commander"

/*  internal dependencies  */
import { JunctionOrchestrator } from "./junction-api-orchestrator.js"

/*  option value types  */
type LogLevel = "error" | "warn" | "info" | "debug"
type Opts = {
    config:    string
    envFile:   string | undefined
    directory: string | undefined
    prune:     boolean
    dryRun:    boolean
    logLevel:  LogLevel
}

/*  configure a commander sub-command for the orchestrator service  */
export function configureCommand (program: Command): Command {
    return program
        .description("Orchestrator service (HAProxy + Mosquitto + Frontend)")
        .addOption(new Option("-c, --config <file>",
            "YAML configuration file")
            .makeOptionMandatory(true))
        .addOption(new Option("-e, --env-file <file>",
            "path to additional \".env\" file, overlaid onto \".env\" in current directory"))
        .addOption(new Option("-d, --directory <dir>",
            "target directory for generated config files (default: auto temp dir)"))
        .addOption(new Option("-p, --prune",
            "prune/clear target directory before generating config files")
            .default(false))
        .addOption(new Option("-n, --dry-run",
            "perform pass 1 (generate configs) only; skip pass 2 (spawning processes)")
            .default(false))
        .addOption(new Option("-L, --log-level <level>",
            "Logging level").choices([ "error", "warn", "info", "debug" ])
            .default("info"))
        .action(async (opts: Opts) => {
            /*  establish service  */
            const service = new JunctionOrchestrator(opts.config, {
                envFile:   opts.envFile,
                directory: opts.directory,
                prune:     opts.prune,
                dryRun:    opts.dryRun,
                logLevel:  opts.logLevel
            })
            await service.start()

            /*  dry-run: pass 1 only, stop immediately  */
            if (opts.dryRun) {
                await service.stop()
                process.exit(0)
            }

            /*  handle graceful shutdown  */
            const shutdown = async () => {
                await service.stop()
                process.exit(0)
            }
            process.on("SIGINT",  shutdown)
            process.on("SIGTERM", shutdown)
        })
}


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
import { Command }  from "commander"

/*  package metadata  */
import pkg          from "../package.json" with { type: "json" }

/*  internal dependencies  */
import { configureCommand as configureFrontend     } from "./junction-cli-frontend.js"
import { configureCommand as configureBackend      } from "./junction-cli-backend.js"
import { configureCommand as configureBroker       } from "./junction-cli-broker.js"
import { configureCommand as configureOrchestrator } from "./junction-cli-orchestrator.js"

/*  main entry point  */
async function main (): Promise<void> {
    const program = new Command()
        .name("junction")
        .description("HTTP/REST over MQTT Gateway")
        .usage("<command> [options]")
        .version(pkg.version, "-v, --version", "show version")
        .helpOption("-h, --help", "show help")
    configureFrontend(program.command("frontend"))
    configureBackend(program.command("backend"))
    configureBroker(program.command("broker"))
    configureOrchestrator(program.command("orchestrator"))
    await program.parseAsync(process.argv)
}

/*  run CLI  */
main().catch((err) => {
    console.error(`** ERROR: ${err}`)
    process.exit(1)
})


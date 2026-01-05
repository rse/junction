/*
**  MQTT+ -- MQTT Communication Patterns
**  Copyright (c) 2018-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
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

import * as Vite             from "vite"
import { tscPlugin }         from "@wroud/vite-plugin-tsc"
import { viteSingleFile }    from "vite-plugin-singlefile"
import { nodePolyfills }     from "vite-plugin-node-polyfills"

const formats = process.env.VITE_BUILD_FORMATS ?? "esm"

export default Vite.defineConfig(({ command, mode }) => ({
    logLevel: "info",
    appType:  "custom",
    base:     "",
    root:     "",
    plugins: [
        tscPlugin({
            tscArgs:        [ "--project", "etc/tsc.json" ],
            packageManager: "npx",
            prebuild:       true
        }),
        ...(formats === "umd" ? [ nodePolyfills() ] : []),
        viteSingleFile()
    ],
    build: {
        rollupOptions: {
            external: formats === "umd" ? [] : [ "stream" ]
        },
        lib: {
            entry:    "dst-stage1/mqtt-plus.js",
            formats:  formats.split(","),
            name:     "MQTTp",
            fileName: (format) => `mqtt-plus.${format === "es" ? "esm" : format}.js`
        },
        target:                 formats === "umd" ? "es2022" : "node20",
        outDir:                 "dst-stage2",
        assetsDir:              "",
        emptyOutDir:            (mode === "production") && formats !== "umd",
        chunkSizeWarningLimit:  5000,
        assetsInlineLimit:      0,
        sourcemap:              (mode === "development"),
        minify:                 (mode === "production") && formats === "umd",
        reportCompressedSize:   (mode === "production")
    }
}))

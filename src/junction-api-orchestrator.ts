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
import fs                       from "node:fs/promises"
import os                       from "node:os"
import path                     from "node:path"
import { fileURLToPath }        from "node:url"
import { spawn }                from "node:child_process"
import type { ChildProcess }    from "node:child_process"

/*  external dependencies  */
import dotenvx                  from "@dotenvx/dotenvx"
import yaml                     from "js-yaml"
import nunjucks                 from "nunjucks"
import nunjucksAddons           from "@rse/nunjucks-addons"
import * as v                   from "valibot"
import { execa }                from "execa"
import selfsigned               from "selfsigned"

/*  internal dependencies  */
import { makeLogger }           from "./junction-api-logger.js"
import type { JunctionLogger, LogLevel, LogSink } from "./junction-api-logger.js"

/*  service options  */
type Options = {
    envFile:   string | undefined
    directory: string | undefined
    prune:     boolean
    dryRun:    boolean
    logLevel:  LogLevel
    logSink?:  LogSink
}

/*  ==== YAML config schema ====  */

const Port = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))
const Pos  = v.pipe(v.number(), v.integer(), v.minValue(1))
const Id   = v.pipe(v.number(), v.integer(), v.minValue(0))

const HostPort = v.strictObject({
    addr: v.string(),
    port: Port
})

const HostPortAuth = v.strictObject({
    addr: v.string(),
    port: Port,
    user: v.string(),
    pass: v.string()
})

const Forward = v.pipe(v.string(),
    v.regex(/^(?:broker:[a-z][a-z0-9-]*:(?:frontend|backend)|gateway:[a-z][a-z0-9-]*)$/))

const ConfigObject = v.strictObject({
    run: v.strictObject({
        dir: v.string(),
        uid: v.union([ v.literal("inherit"), Id, v.string() ]),
        gid: v.union([ v.literal("inherit"), Id, v.string() ])
    }),
    router: v.strictObject({
        type:    v.picklist([ "haproxy", "nftables" ]),
        service: HostPort,
        acme:    v.optional(HostPort)
    }),
    proxy: v.strictObject({
        instances: Pos,
        frontend:  HostPort,
        tls: v.pipe(v.strictObject({
            type:  v.picklist([ "self-signed", "lets-encrypt" ]),
            email: v.string(),
            addr:  v.string(),
            port:  v.optional(Port),
            fqdn:  v.array(v.string())
        }), v.check((tls) => tls.type !== "lets-encrypt" || tls.port !== undefined,
            "tls.port is required when tls.type is \"lets-encrypt\""
        )),
        backend: v.array(v.strictObject({
            "host-match": v.string(),
            "path-match": v.string(),
            "path-subst": v.string(),
            "forward":    Forward
        }))
    }),
    gateway: v.record(v.string(), v.strictObject({
        instances: Pos,
        addr:      v.string(),
        port:      Port
    })),
    broker: v.record(v.string(), v.strictObject({
        instances: v.strictObject({
            frontend: Pos,
            backend:  Pos
        }),
        frontend: HostPort,
        bridge:   HostPortAuth,
        backend:  HostPortAuth
    }))
})

/*  YAML config inferred output type  */
type Config = v.InferOutput<typeof ConfigObject>

/*  full config schema with cross-field validation  */
const ConfigSchema = v.pipe(ConfigObject,
    v.check((cfg: Config) => cfg.proxy.tls.type !== "lets-encrypt" || cfg.router.acme !== undefined,
        "router.acme is required when proxy.tls.type is \"lets-encrypt\""))

/*  child descriptor  */
type Child = {
    name:    string
    process: ChildProcess
}

/*  service  */
export class JunctionOrchestrator {
    /*  internal state  */
    private children:    Child[]               | null = null
    private runDir:      string                | null = null
    private runDirOwned: boolean                      = false
    private config:      Config                | null = null
    private env:         nunjucks.Environment  | null = null
    private logger!:     JunctionLogger
    private started:     boolean                      = false

    /*  API construction  */
    constructor (
        private configFile: string,
        private options:    Options
    ) {}

    /*  start service: pass 1 always, pass 2 unless dry-run  */
    async start () {
        /*  sanity check state  */
        if (this.started)
            throw new Error("service already started")

        /*  establish logging facility  */
        this.logger = makeLogger(this.options.logLevel, this.options.logSink)
        this.logger.info("starting Junction ORCHESTRATOR service")

        /*  load optional ".env" file (silent on success, no error if absent);
            with an extra "--env-file", the default cwd ".env" is loaded first
            and the supplied file is overlaid on top (its values win on conflict)  */
        if (this.options.envFile !== undefined)
            this.logger.info(`config: loading env file: "${this.options.envFile}" (overlaid onto ".env")`)
        dotenvx.config({ quiet: true, ignore: [ "MISSING_ENV_FILE" ],
            ...(this.options.envFile !== undefined
                ? { path: [ ".env", this.options.envFile ], overload: true } : {}) })

        /*  load and parse YAML configuration  */
        this.logger.info(`config: loading: "${this.configFile}"`)
        const text = await fs.readFile(this.configFile, "utf8")
        const raw  = yaml.load(text)

        /*  apply optional JUNCTION_* environment variable overrides  */
        this.applyEnvOverrides(raw)

        /*  validate schema of YAML configuration  */
        const result = v.safeParse(ConfigSchema, raw)
        if (!result.success) {
            const flat = v.flatten<typeof ConfigSchema>(result.issues)
            const lines: string[] = []
            if (flat.root)
                for (const msg of flat.root)
                    lines.push(`  - <root>: ${msg}`)
            if (flat.nested)
                for (const [ p, msgs ] of Object.entries(flat.nested))
                    if (msgs)
                        for (const msg of msgs)
                            lines.push(`  - ${p}: ${msg}`)
            throw new Error(`config: validation failed:\n${lines.join("\n")}`)
        }
        const config: Config = result.output
        this.config = config
        this.logger.info("config: successfully validated")

        /*  prepare run directory  */
        if (this.options.directory !== undefined) {
            const dir = path.resolve(this.options.directory)
            await fs.mkdir(dir, { recursive: true })
            this.runDir      = dir
            this.runDirOwned = false
            this.logger.info(`run dir: "${dir}" (user-supplied, preserved)`)
        }
        else if (config.run?.dir !== undefined) {
            const dir = path.resolve(config.run.dir as string)
            await fs.mkdir(dir, { recursive: true })
            this.runDir      = dir
            this.runDirOwned = false
            this.logger.info(`run dir: "${dir}" (config-supplied, preserved)`)
        }
        else {
            const tmpRoot = os.tmpdir()
            const dir = await fs.mkdtemp(path.join(tmpRoot, "junction-orchestrator-"))
            this.runDir      = dir
            this.runDirOwned = true
            this.logger.info(`run dir: "${dir}" (auto-generated, removed on termination)`)
        }

        /*  optionally prune/clear run directory  */
        if (this.options.prune && !this.runDirOwned) {
            const dir = this.runDir
            this.logger.info(`run dir: "${dir}" (pruning entries)`)
            const entries = await fs.readdir(dir)
            for (const entry of entries)
                await fs.rm(path.join(dir, entry), { recursive: true, force: true })
        }

        /*  setup Nunjucks environment with @rse/nunjucks-addons  */
        const here = path.dirname(fileURLToPath(import.meta.url))
        const templatesDir = path.resolve(here, "..", "src", "templates")
        const env = nunjucks.configure(templatesDir, { autoescape: false })
        nunjucksAddons(env)
        this.env = env

        /*  PASS 1: generate config files  */
        this.logger.info("pass 1: generating config files")
        await this.generate()

        /*  fixate ownership of all generated files (only effective as root)  */
        await this.applyOwnership()

        /*  PASS 2: spawn processes (skipped on dry-run)  */
        if (!this.options.dryRun) {
            this.logger.info("pass 2: spawning child processes")
            await this.spawnAll()
        }
        else
            this.logger.info("pass 2: spawning child processes skipped (dry-run)")

        /*  update state  */
        this.started = true
    }

    /*  apply JUNCTION_* environment variable overrides onto the raw config object:
        "JUNCTION_XX_YY" overrides "xx.yy", numeric segments index arrays
        ("JUNCTION_FOO_BAR_3_QUUX" -> "foo.bar[3].quux"), and only pre-existing
        scalar leaves are overwritten (coerced to the leaf's current type)  */
    private applyEnvOverrides (raw: unknown) {
        for (const name of Object.keys(process.env).sort()) {
            const m = name.match(/^JUNCTION_(.+)$/)
            if (m === null)
                continue
            const value = process.env[name]!
            const segs  = m[1].toLowerCase().split("_")

            /*  descend into the parent of the addressed leaf  */
            let node: any = raw
            let ok = true
            for (let i = 0; i < segs.length - 1; i++) {
                const key = /^[0-9]+$/.test(segs[i]) ? Number(segs[i]) : segs[i]
                if (node === null || typeof node !== "object" || !(key in node)) {
                    ok = false
                    break
                }
                node = node[key]
            }
            const path = segs.join(".")
            if (!ok || node === null || typeof node !== "object") {
                this.logger.warn(`config: env override: ${name}: no such config path "${path}" (skipped)`)
                continue
            }

            /*  overwrite the leaf only if it pre-exists and is a scalar  */
            const last = /^[0-9]+$/.test(segs[segs.length - 1])
                ? Number(segs[segs.length - 1]) : segs[segs.length - 1]
            if (!(last in node) || node[last] === null || typeof node[last] === "object") {
                this.logger.warn(`config: env override: ${name}: no such config path "${path}" (skipped)`)
                continue
            }

            /*  coerce the string value to the current leaf type  */
            let coerced: string | number | boolean = value
            if (typeof node[last] === "number") {
                const n = Number(value)
                if (Number.isNaN(n)) {
                    this.logger.warn(`config: env override: ${name}: value "${value}" is not a number (skipped)`)
                    continue
                }
                coerced = n
            }
            else if (typeof node[last] === "boolean") {
                if (value !== "true" && value !== "false") {
                    this.logger.warn(`config: env override: ${name}: value "${value}" is not a boolean (skipped)`)
                    continue
                }
                coerced = value === "true"
            }
            node[last] = coerced

            /*  log the applied override, masking secret-looking values  */
            const shown = /pass/i.test(path) ? "********" : `${coerced}`
            this.logger.info(`config: env override: ${path}: "${shown}"`)
        }
    }

    /*  PASS 1: render all templates and write per-instance config files  */
    private async generate () {
        const env    = this.env!
        const config = this.config!
        const runDir = this.runDir!
        const here = path.dirname(fileURLToPath(import.meta.url))
        const srcDir = path.resolve(here, "..", "src", "templates")

        /*  generate ROUTER configuration  */
        let srcFile
        let dstFile
        if (config.router.type === "nftables") {
            srcFile = path.join(srcDir, "router-nftables.conf.njk")
            dstFile = path.join(runDir, "router-nftables.conf")
        }
        else if (config.router.type === "haproxy") {
            srcFile = path.join(srcDir, "router-haproxy.conf.njk")
            dstFile = path.join(runDir, "router-haproxy.conf")
        }
        else
            throw new Error("invalid router type")
        const src = await fs.readFile(srcFile, "utf8")
        this.logger.info(`pass 1: read:  "${srcFile}"`)
        const dst = env.renderString(src, { ...config })
        await fs.writeFile(dstFile, dst, { encoding: "utf8", mode: 0o644 })
        await fs.chmod(dstFile, 0o644)
        this.logger.info(`pass 1: wrote: "${dstFile}"`)

        /*  generate self-signed CA and server key/cert pair (for self-signed TLS)  */
        if (config.proxy.tls.type === "self-signed") {
            const notBefore  = new Date(Date.now())
            const caNotAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
            const svNotAfter = new Date(Date.now() +  1 * 365 * 24 * 60 * 60 * 1000)

            /*  generate the CA key/cert pair (self-signed)  */
            const caPems = await selfsigned.generate([
                { name: "commonName",       value: "Junction CA" },
                { name: "organizationName", value: "Junction" }
            ], {
                keySize:       2048,
                algorithm:     "sha256",
                notBeforeDate: notBefore,
                notAfterDate:  caNotAfter,
                extensions: [
                    { name: "basicConstraints", cA: true, critical: true },
                    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true }
                ]
            })

            /*  derive subjectAltName entries from the configured FQDNs (and frontend address)  */
            const altNames: Array<{ type: 1 | 2 | 6 | 7, value?: string, ip?: string }> =
                config.proxy.tls.fqdn.map((fqdn) => ({ type: 2, value: fqdn }))
            if (/^\d+\.\d+\.\d+\.\d+$/.test(config.proxy.frontend.addr))
                altNames.push({ type: 7, ip: config.proxy.frontend.addr })

            /*  generate the server key/cert pair (signed by the CA)  */
            const svPems = await selfsigned.generate([
                { name: "commonName",       value: config.proxy.tls.fqdn[0] },
                { name: "organizationName", value: "Junction" }
            ], {
                keySize:       2048,
                algorithm:     "sha256",
                notBeforeDate: notBefore,
                notAfterDate:  svNotAfter,
                ca: { key: caPems.private, cert: caPems.cert },
                extensions: [
                    { name: "basicConstraints", cA: false },
                    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
                    { name: "extKeyUsage", serverAuth: true },
                    { name: "subjectAltName", altNames }
                ]
            })

            /*  build the combined PEM bundle (server cert + CA chain cert + server key) for HAProxy:
                the leaf certificate matching the key must come first, then the CA chain, then the key  */
            const nl  = (pem: string) => pem.replace(/\n*$/, "\n")
            const pem = nl(svPems.cert) + nl(caPems.cert) + nl(svPems.private)

            /*  write CA, server, and combined key/cert files into the run directory  */
            const artifacts: Array<{ file: string, data: string, mode: number }> = [
                { file: "proxy-ca.crt", data: caPems.cert,    mode: 0o644 },
                { file: "proxy-ca.key", data: caPems.private, mode: 0o600 },
                { file: "proxy-sv.crt", data: svPems.cert,    mode: 0o644 },
                { file: "proxy-sv.key", data: svPems.private, mode: 0o600 },
                { file: "proxy-sv.pem", data: pem,            mode: 0o600 }
            ]
            for (const a of artifacts) {
                const dstFile = path.join(runDir, a.file)
                await fs.writeFile(dstFile, a.data, { encoding: "utf8", mode: a.mode })
                await fs.chmod(dstFile, a.mode)
                this.logger.info(`pass 1: wrote: "${dstFile}"`)
            }
        }

        /*  generate PROXY configuration  */
        const proxyCount = config.proxy?.instances ?? 0
        for (let i = 0; i < proxyCount; i++) {
            const port = (config.proxy.frontend.port as number) + i
            const srcFile = path.join(srcDir, "proxy.conf.njk")
            const dstFile = path.join(runDir, `proxy-${String(i).padStart(2, "0")}.conf`)
            this.logger.info(`pass 1: read:  "${srcFile}"`)
            const src = await fs.readFile(srcFile, "utf8")
            const dst = env.renderString(src, {
                ...config,
                logLevel: this.options.logLevel,
                instance: { index: i, total: proxyCount, port }
            })
            await fs.writeFile(dstFile, dst, { encoding: "utf8", mode: 0o644 })
            await fs.chmod(dstFile, 0o644)
            this.logger.info(`pass 1: wrote: "${dstFile}"`)
        }

        /*  Mosquitto brokers (per broker, per role, per instance)  */
        const brokers = (config.broker ?? {}) as Record<string, any>
        for (const [ name, bcfg ] of Object.entries(brokers)) {
            const roles = [
                { role: "frontend" as const, count: bcfg.instances.frontend,
                    addr: bcfg.frontend.addr, basePort: bcfg.frontend.port },
                { role: "backend"  as const, count: bcfg.instances.backend,
                    addr: bcfg.backend.addr,  basePort: bcfg.backend.port }
            ]
            for (const r of roles) {
                for (let i = 0; i < r.count; i++) {
                    const port = r.basePort + i
                    const srcFile = path.join(srcDir, `broker-${r.role}.conf.njk`)
                    const dstFile = path.join(runDir, `broker-${name}-${r.role}-${String(i).padStart(2, "0")}.conf`)
                    this.logger.info(`pass 1: read:  "${srcFile}"`)
                    const rendered = env.render(srcFile, {
                        ...config,
                        logLevel: this.options.logLevel,
                        instance: { name, role: r.role, index: i, addr: r.addr, port }
                    })
                    await fs.writeFile(dstFile, rendered, { encoding: "utf8", mode: 0o644 })
                    await fs.chmod(dstFile, 0o644)
                    this.logger.info(`pass 1: wrote: "${dstFile}"`)
                }

                const srcFile = path.join(srcDir, `broker-${r.role}-acl.txt.njk`)
                let dstFile = path.join(runDir, `broker-${name}-${r.role}-acl.txt`)
                this.logger.info(`pass 1: read:  "${srcFile}"`)
                const rendered = env.render(srcFile, {
                    ...config,
                    instance: { name }
                })
                await fs.writeFile(dstFile, rendered, { encoding: "utf8", mode: 0o600 })
                await fs.chmod(dstFile, 0o600)
                this.logger.info(`pass 1: wrote: "${dstFile}"`)

                dstFile = path.join(runDir, `broker-${name}-${r.role}-pwd.txt`)
                let pwd = ""
                if (r.role === "backend") {
                    const { stdout: out1 } = await execa("mosquitto_passwd", [
                        "-b", "-c", "-",
                        config.broker[name].bridge.user,
                        config.broker[name].bridge.pass
                    ], { stripFinalNewline: false })
                    pwd += out1
                    const { stdout: out2 } = await execa("mosquitto_passwd", [
                        "-b", "-c", "-",
                        config.broker[name].backend.user,
                        config.broker[name].backend.pass
                    ], { stripFinalNewline: false })
                    pwd += out2
                }
                await fs.writeFile(dstFile, pwd, { encoding: "utf8", mode: 0o600 })
                await fs.chmod(dstFile, 0o600)
                this.logger.info(`pass 1: wrote: "${dstFile}"`)
            }
        }
    }

    /*  fixate ownership of run dir and all generated files to the configured
        run.uid/run.gid (names or numeric ids); a no-op unless running as root,
        as chown(2) requires privilege, and a no-op for any axis set to "inherit"  */
    private async applyOwnership () {
        const config = this.config!
        const runDir = this.runDir!
        const uidCfg = config.run.uid
        const gidCfg = config.run.gid

        /*  nothing to do when both axes inherit the current ownership  */
        if (uidCfg === "inherit" && gidCfg === "inherit")
            return

        /*  chown(2) requires root privileges, so skip otherwise  */
        if (process.getuid === undefined || process.getuid() !== 0) {
            this.logger.warn(`ownership: not running as root, skipping chown to ${uidCfg}:${gidCfg}`)
            return
        }

        /*  resolve a configured user/group (name or numeric id) to a numeric id,
            using "-1" as the chown(2) sentinel meaning "leave this axis unchanged"  */
        const resolve = async (which: "user" | "group", val: string | number) => {
            if (val === "inherit")
                return -1
            if (typeof val === "number")
                return val
            if (/^[0-9]+$/.test(val))
                return Number(val)
            if (which === "user") {
                const { stdout } = await execa("id", [ "-u", val ])
                return Number(stdout.trim())
            }
            else {
                const { stdout } = await execa("getent", [ "group", val ])
                return Number(stdout.trim().split(":")[2])
            }
        }
        const uid = await resolve("user",  uidCfg)
        const gid = await resolve("group", gidCfg)
        this.logger.info(`ownership: applying ${uidCfg}:${gidCfg} (uid=${uid} gid=${gid}) under "${runDir}"`)

        /*  recursively chown the run dir and all entries below it  */
        const chownRec = async (p: string) => {
            await fs.chown(p, uid, gid)
            const st = await fs.lstat(p)
            if (st.isDirectory()) {
                const entries = await fs.readdir(p)
                for (const entry of entries)
                    await chownRec(path.join(p, entry))  /*  RECURSION  */
            }
        }
        await chownRec(runDir)
    }

    /*  PASS 2: spawn haproxy + mosquitto + frontend children  */
    private async spawnAll () {
        const config = this.config!
        const runDir = this.runDir!
        const children: Child[] = []
        this.children = children

        /*  helper function for delayed operation  */
        const sleep = (ms: number) =>
            new Promise((resolve) => setTimeout(resolve, ms))

        /*  Mosquitto brokers  */
        const brokers = (config.broker ?? {}) as Record<string, any>
        for (const [ name, bcfg ] of Object.entries(brokers)) {
            const roles = [
                { role: "backend"  as const, count: bcfg.instances.backend  },
                { role: "frontend" as const, count: bcfg.instances.frontend }
            ]
            for (const r of roles) {
                for (let i = 0; i < r.count; i++) {
                    const file = path.join(runDir, `broker-${name}-${r.role}-${String(i).padStart(2, "0")}.conf`)
                    const tag  = `broker[${name}/${r.role}/${i}]`
                    const child = spawn("mosquitto", [ "-c", file ], { stdio: "pipe", cwd: runDir })
                    this.capture(child, tag)
                    children.push({ name: `broker-${name}-${r.role}-${String(i).padStart(2, "0")}`, process: child })
                    this.logger.info(`pass 2: spawned: ${tag}: pid=${child.pid}`)
                    await sleep(1000)
                }
            }
        }
        await sleep(1000)

        /*  HAProxy instances  */
        const proxyCount = config.proxy?.instances ?? 0
        for (let i = 0; i < proxyCount; i++) {
            const file = path.join(runDir, `proxy-${String(i).padStart(2, "0")}.conf`)
            const tag  = `proxy[${i}]`
            const args = this.options.logLevel === "debug" ? [ "-d", "-f", file ] : [ "-f", file ]
            const child = spawn("haproxy", args, { stdio: "pipe", cwd: runDir })
            this.capture(child, tag)
            children.push({ name: `proxy-${String(i).padStart(2, "0")}`, process: child })
            this.logger.info(`pass 2: spawned: ${tag}: pid=${child.pid}`)
        }
        await sleep(1000)

        /*  HAProxy router instance (single; only for the "haproxy" router type)  */
        if (config.router.type === "haproxy") {
            const file = path.join(runDir, "router-haproxy.conf")
            const tag  = "router"
            const args = this.options.logLevel === "debug" ? [ "-d", "-f", file ] : [ "-f", file ]
            const child = spawn("haproxy", args, { stdio: "pipe", cwd: runDir })
            this.capture(child, tag)
            children.push({ name: "router", process: child })
            this.logger.info(`pass 2: spawned: ${tag}: pid=${child.pid}`)
        }

        /*  NFTables router ruleset (single one-shot apply; only for the "nftables" router type):
            "nft -f" loads the generated ruleset into the kernel and exits immediately, so unlike
            HAProxy it is not a long-lived child to supervise -- it is awaited to completion here.
            Loading into the host's "nat" table requires CAP_NET_ADMIN and host networking, hence
            this is intended for a privileged, host-network container or a bare-metal deployment.  */
        if (config.router.type === "nftables") {
            const file = path.join(runDir, "router-nftables.conf")
            const tag  = "router"

            /*  warn early if lacking the privilege required to load a host ruleset:
                "nft -f" needs CAP_NET_ADMIN (effectively root), and for the DNAT rules
                to affect host traffic the process must share the host network namespace
                (e.g. a container run with "--network=host --cap-add=NET_ADMIN")  */
            if (process.getuid !== undefined && process.getuid() !== 0)
                this.logger.warn(`${tag}: not running as root -- "nft -f" likely lacks ` +
                    "CAP_NET_ADMIN to load the NFTables ruleset (run as root, and under " +
                    "host networking with NET_ADMIN if containerized)")

            this.logger.info(`pass 2: applying: ${tag}: "nft -f ${file}"`)
            try {
                const { stdout, stderr } = await execa("nft", [ "-f", file ], { cwd: runDir })
                for (const line of `${stdout}\n${stderr}`.split(/\r?\n/))
                    if (line !== "")
                        this.logger.info(`${tag}: ${line}`)
                this.logger.info(`pass 2: applied:  ${tag}: NFTables ruleset loaded`)
            }
            catch (err: any) {
                throw new Error(`pass 2: failed to apply NFTables ruleset via "nft -f ${file}": ${err.message}`)
            }
        }
        await sleep(1000)

        /*  Junction frontend instances  */
        const selfCli  = fileURLToPath(new URL("./junction-cli.js", import.meta.url))
        const gateways = (config.gateway ?? {}) as Record<string, any>
        for (const [ name, gcfg ] of Object.entries(gateways)) {
            for (let i = 0; i < gcfg.instances; i++) {
                const httpPort = gcfg.port + i
                const mqttPort = config.proxy.frontend.port + (i % config.proxy.instances)
                const mqttHost = config.proxy.frontend.addr
                const httpUrl  = `http://${gcfg.addr}:${httpPort}/`
                const mqttUrl  = `wss://${mqttHost}:${mqttPort}/${name}/api/client/`
                const args = [
                    selfCli, "frontend",
                    "-l", httpUrl,
                    "-c", mqttUrl,
                    "-L", this.options.logLevel
                ]
                const tag = `gateway[${name}/${String(i).padStart(2, "0")}]`
                const child = spawn(process.execPath, args, { stdio: "pipe", cwd: runDir })
                this.capture(child, tag)
                children.push({ name: `gateway-${name}-${String(i).padStart(2, "0")}`, process: child })
                this.logger.info(`pass 2: spawned: ${tag}: pid=${child.pid}`)
            }
        }
    }

    /*  capture child stdout/stderr into pino  */
    private capture (child: ChildProcess, tag: string) {
        const onData = (data: Buffer | string) => {
            const msgs = (typeof data === "string" ? data : data.toString()).split(/\r?\n/)
            for (const msg of msgs)
                if (msg !== "")
                    this.logger.info(`${tag}: ${msg}`)
        }
        child.stdout?.on("data", onData)
        child.stderr?.on("data", onData)
        child.on("exit", (code, signal) => {
            this.logger.warn(`${tag}: exited code=${code} signal=${signal}`)
        })
    }

    /*  stop service  */
    async stop () {
        /*  sanity check state  */
        if (!this.started)
            throw new Error("service not started")

        /*  terminate children  */
        if (this.children !== null) {
            this.logger.info("stopping child processes")
            for (const c of this.children)
                if (c.process.exitCode === null)
                    c.process.kill("SIGTERM")
            await Promise.all(this.children.map((c) => new Promise<void>((resolve) => {
                if (c.process.exitCode !== null)
                    resolve()
                else
                    c.process.on("exit", () => resolve())
            })))
            this.children = null
        }

        /*  remove run dir only when auto-created  */
        if (this.runDir !== null && this.runDirOwned) {
            this.logger.info(`removing run dir: "${this.runDir}"`)
            await fs.rm(this.runDir, { recursive: true, force: true })
        }
        this.runDir = null

        /*  cleanup  */
        this.env    = null
        this.config = null

        /*  update state  */
        this.started = false
    }
}


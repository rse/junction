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
import Hapi                     from "@hapi/hapi"
import * as acme                from "@certd/acme-client"

/*  internal dependencies  */
import type { JunctionLogger }  from "./junction-api-logger.js"

/*  facility options  */
type Options = {
    addr:    string
    port:    number
    email:   string
    staging: boolean
    logger:  JunctionLogger
}

/*  the PEM encoded results of a successful certificate order  */
export type Certificate = {
    accountKey: string            /*  ACME account private key (reusable across orders)  */
    key:        string            /*  certificate private key  */
    cert:       string            /*  certificate chain (leaf certificate first)  */
}

/*  the identities and the expiry of an already existing certificate  */
export type CertificateInfo = {
    fqdn:     string[]
    notAfter: Date
}

/*  maximum number of certificate order attempts and the delay in between  */
const orderAttempts = 10
const orderDelay    = 60 * 1000

/*  determine the FQDNs covered by a PEM encoded certificate and its expiry  */
export function certificateInfo (certPem: string): CertificateInfo {
    const info = acme.crypto.readCertificateInfo(certPem)
    const fqdn = [ ...new Set([ info.domains.commonName, ...info.domains.altNames ]) ]
        .filter((name) => typeof name === "string" && name !== "")
    return { fqdn, notAfter: info.notAfter }
}

/*  facility for acquiring CA-signed certificates via the ACME protocol (RFC 8555):
    it permanently owns an HTTP service which answers the ACME "HTTP-01" challenges,
    so both the initial order and all later renewals can be satisfied through it  */
export class JunctionAcme {
    /*  internal state  */
    private hapi:       Hapi.Server        | null = null
    private challenges: Map<string, string>       = new Map<string, string>()
    private started:    boolean                   = false

    /*  API construction  */
    constructor (
        private options: Options
    ) {}

    /*  start facility  */
    async start () {
        /*  sanity check state  */
        if (this.started)
            throw new Error("facility already started")

        /*  bridge the ACME client logging into our own logging facility  */
        acme.setLogger((...args: any[]) => {
            this.options.logger.debug(`acme: ${args.join(" ")}`)
        })

        /*  establish the ACME "HTTP-01" challenge service: it serves the key
            authorization of every currently pending challenge and answers all
            other requests with the Hapi standard "404" response  */
        this.options.logger.info("acme: starting HTTP-01 challenge service: " +
            `"http://${this.options.addr}:${this.options.port}/"`)
        const hapi = Hapi.server({ address: this.options.addr, port: this.options.port })
        hapi.route({
            method:  "GET",
            path:    "/.well-known/acme-challenge/{token}",
            handler: (request, h) => {
                const token = request.params.token
                const key   = this.challenges.get(token)
                if (key === undefined) {
                    this.options.logger.warn(`acme: challenge: unknown token: "${token}"`)
                    return h.response({ error: "Not Found" }).code(404)
                }
                this.options.logger.info(`acme: challenge: answered token: "${token}"`)
                return h.response(key).type("text/plain")
            }
        })
        await hapi.start()
        this.hapi = hapi

        /*  update state  */
        this.started = true
    }

    /*  acquire a CA-signed certificate for the given FQDNs, reusing an already
        existing ACME account key, and retrying a failing order a few times  */
    async acquire (fqdn: string[], accountKey: string | null): Promise<Certificate> {
        /*  sanity check state  */
        if (!this.started)
            throw new Error("facility not started")
        if (fqdn.length === 0)
            throw new Error("at least one FQDN required")

        /*  establish the ACME account key (freshly generated only once)  */
        const accountKeyPem = accountKey ?? (await acme.crypto.createPrivateKey()).toString()

        /*  establish the ACME client for the selected directory  */
        const directoryUrl = this.options.staging
            ? acme.directory.letsencrypt.staging
            : acme.directory.letsencrypt.production
        this.options.logger.info(`acme: using directory: "${directoryUrl}"`)
        const client = new acme.Client({ directoryUrl, accountKey: accountKeyPem })

        /*  establish the certificate key and its Certificate Signing Request  */
        const [ key, csr ] = await acme.crypto.createCsr({
            keySize:    2048,
            commonName: fqdn[0],
            altNames:   fqdn
        })

        /*  order the certificate, retrying a failing order to survive a still
            unreachable challenge service, a DNS not yet pointing here, or a CA outage  */
        this.options.logger.info(`acme: ordering certificate: fqdn: "${fqdn.join(", ")}"`)
        let cert = ""
        for (let attempt = 1; attempt <= orderAttempts; attempt++) {
            try {
                cert = await client.auto({
                    csr,
                    email:                this.options.email,
                    termsOfServiceAgreed: true,
                    challengePriority:    [ "http-01" ],
                    challengeCreateFn: async (authz: any, challenge: any, keyAuthorization: string) => {
                        this.challenges.set(challenge.token, keyAuthorization)
                        this.options.logger.info("acme: challenge: created: " +
                            `fqdn: "${authz.identifier.value}", token: "${challenge.token}"`)
                    },
                    challengeRemoveFn: async (authz: any, challenge: any) => {
                        this.challenges.delete(challenge.token)
                        this.options.logger.info("acme: challenge: removed: " +
                            `fqdn: "${authz.identifier.value}", token: "${challenge.token}"`)
                    }
                })
                break
            }
            catch (err: any) {
                if (attempt === orderAttempts)
                    throw new Error(`acme: certificate order failed after ${attempt} attempts: ${err.message}`)
                this.options.logger.warn(`acme: certificate order attempt ${attempt}/${orderAttempts} ` +
                    `failed: ${err.message} (retrying in ${orderDelay / 1000}s)`)
                await new Promise((resolve) => setTimeout(resolve, orderDelay))
            }
        }
        this.options.logger.info("acme: ordering certificate: succeeded")

        return { accountKey: accountKeyPem, key: key.toString(), cert }
    }

    /*  stop facility  */
    async stop () {
        /*  sanity check state  */
        if (!this.started)
            throw new Error("facility not started")

        /*  terminate the ACME "HTTP-01" challenge service  */
        if (this.hapi !== null) {
            this.options.logger.info("acme: stopping HTTP-01 challenge service")
            await this.hapi.stop()
            this.hapi = null
        }
        this.challenges.clear()

        /*  update state  */
        this.started = false
    }
}

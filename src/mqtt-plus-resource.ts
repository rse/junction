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

/*  built-in requirements  */
import stream                          from "stream"

/*  external requirements  */
import { IClientPublishOptions,
    IClientSubscribeOptions }          from "mqtt"
import { nanoid }                      from "nanoid"

/*  internal requirements  */
import { ResourceRequest,
    ResourceResponse }                 from "./mqtt-plus-msg"
import { APISchema, ResourceKeys,
    APIEndpointResource }              from "./mqtt-plus-api"
import type { WithInfo,
    InfoResource }                     from "./mqtt-plus-info"
import type { Receiver }               from "./mqtt-plus-receiver"
import { ServiceTrait }                from "./mqtt-plus-service"

/*  the registration result type  */
export interface Provisioning {
    unprovision (): Promise<void>
}

/*  Resource Communication Trait  */
export class ResourceTrait<T extends APISchema = APISchema> extends ServiceTrait<T> {
    /*  resource state  */
    private provisionings =
        new Map<string, WithInfo<APIEndpointResource, InfoResource>>()
    private fetchCallback =
        new Map<string, {
            resource: string,
            callback: (error: Error | undefined, chunk: Buffer | null | undefined) => void
        }>()

    /*  provision an RPC resource  */
    async provision<K extends ResourceKeys<T> & string> (
        resource: K,
        callback: WithInfo<T[K], InfoResource>
    ): Promise<Provisioning>
    async provision<K extends ResourceKeys<T> & string> (
        resource: K,
        options:  Partial<IClientSubscribeOptions>,
        callback: WithInfo<T[K], InfoResource>
    ): Promise<Provisioning>
    async provision<K extends ResourceKeys<T> & string> (
        resource: K,
        ...args:  any[]
    ): Promise<Provisioning> {
        /*  determine parameters  */
        let options:  Partial<IClientSubscribeOptions> = {}
        let callback: WithInfo<T[K], InfoResource> = args[0]
        if (args.length === 2 && typeof args[0] === "object") {
            options  = args[0]
            callback = args[1]
        }

        /*  sanity check situation  */
        if (this.provisionings.has(resource))
            throw new Error(`provision: resource "${resource}" already provisioned`)

        /*  generate the corresponding MQTT topics for broadcast and direct use  */
        const topicB = this.options.topicMake(resource, "resource-transfer-request")
        const topicD = this.options.topicMake(resource, "resource-transfer-request", this.options.id)

        /*  subscribe to MQTT topics  */
        await Promise.all([
            this._subscribeTopic(topicB, { qos: 2, ...options }),
            this._subscribeTopic(topicD, { qos: 2, ...options })
        ]).catch((err: Error) => {
            this._unsubscribeTopic(topicB).catch(() => {})
            this._unsubscribeTopic(topicD).catch(() => {})
            throw err
        })

        /*  remember the provisioning  */
        this.provisionings.set(resource, callback as WithInfo<APIEndpointResource, InfoResource>)

        /*  provide a provisioning for subsequent unprovisioning  */
        const self = this
        const provisioning: Provisioning = {
            async unprovision (): Promise<void> {
                if (!self.provisionings.has(resource))
                    throw new Error(`unprovision: resource "${resource}" not provisioned`)
                self.provisionings.delete(resource)
                return Promise.all([
                    self._unsubscribeTopic(topicB),
                    self._unsubscribeTopic(topicD)
                ]).then(() => {})
            }
        }
        return provisioning
    }

    /*  fetch resource  */
    async fetch<K extends ResourceKeys<T> & string> (
        resource:  K,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    async fetch<K extends ResourceKeys<T> & string> (
        resource:  K,
        receiver:  Receiver,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    async fetch<K extends ResourceKeys<T> & string> (
        resource:  K,
        options:   IClientPublishOptions,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    async fetch<K extends ResourceKeys<T> & string> (
        resource:  K,
        receiver:  Receiver,
        options:   IClientPublishOptions,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    async fetch<K extends ResourceKeys<T> & string> (
        resource:  K,
        ...args:   any[]
    ): Promise<Awaited<ReturnType<T[K]>>> {
        /*  determine actual parameters  */
        const { receiver, options, params } = this._parseCallArgs(args)

        /*  generate unique request id for the request  */
        const requestId = nanoid()

        /*  subscribe to stream response topic  */
        const responseTopic = this.options.topicMake(resource, "resource-transfer-response", this.options.id)
        await this._subscribeTopic(responseTopic, { qos: 2 })

        /*  create promise for collecting stream chunks  */
        const resultPromise = new Promise<Buffer>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null

            /*  utility function for cleanup  */
            const cleanup = () => {
                if (timer !== null) {
                    clearTimeout(timer)
                    timer = null
                }
                this._unsubscribeTopic(responseTopic).catch(() => {})
                this.fetchCallback.delete(requestId)
            }

            /*  start timeout handler  */
            timer = setTimeout(() => {
                cleanup()
                reject(new Error("communication timeout"))
            }, this.options.timeout)

            /*  register stream handler to collect chunks  */
            const chunks: Buffer[] = []
            this.fetchCallback.set(requestId, {
                resource,
                callback: (error: Error | undefined, chunk: Buffer | null | undefined) => {
                    if (error !== undefined) {
                        cleanup()
                        reject(error)
                    }
                    else if (chunk !== undefined) {
                        if (chunk !== null)
                            chunks.push(chunk)
                        else {
                            cleanup()
                            resolve(Buffer.concat(chunks))
                        }
                    }
                }
            })
        })

        /*  generate encoded message  */
        const request = this.msg.makeResourceRequest(requestId, resource, params, this.options.id, receiver)
        const message = this.codec.encode(request)

        /*  generate corresponding MQTT topic  */
        const topic = this.options.topicMake(resource, "resource-transfer-request", receiver)

        /*  publish message to MQTT topic  */
        this.mqtt.publish(topic, message, { qos: 2, ...options })

        return resultPromise as Promise<Awaited<ReturnType<T[K]>>>
    }

    /*  dispatch message (Resource pattern handling)  */
    protected _dispatchMessage (topic: string, parsed: any) {
        super._dispatchMessage(topic, parsed)
        const topicMatch = this.options.topicMatch(topic)
        if (topicMatch !== null
            && topicMatch.operation === "resource-transfer-request"
            && parsed instanceof ResourceRequest) {
            /*  handle resource request  */
            const name = parsed.resource
            const handler = this.provisionings.get(name)
            if (handler !== undefined) {
                const requestId = parsed.id
                const resource  = parsed.resource
                const params    = parsed.params ?? []
                const sender    = parsed.sender ?? ""
                const receiver  = parsed.receiver
                const info: InfoResource = { sender, receiver }
                Promise.resolve()
                    .then(() => handler(...params, info))
                    .then((result: Buffer) => {
                        /*  ensure the receiving buffer is really a Buffer also under runtime  */
                        if (result !== null && !Buffer.isBuffer(result))
                            result = Buffer.from(result)

                        /*  generate corresponding MQTT topic  */
                        const topic = this.options.topicMake(resource, "resource-transfer-response", sender)

                        /*  split Buffer into chunks and send them back  */
                        const chunkSize = this.options.chunkSize
                        for (let i = 0; i < result.byteLength; i += chunkSize) {
                            const size = Math.min(result.byteLength - i, chunkSize)
                            const chunk = result.subarray(i, i + size)

                            /*  generate encoded message  */
                            const request = this.msg.makeResourceResponse(requestId, chunk, undefined, this.options.id, sender)
                            const message = this.codec.encode(request)

                            /*  publish message to MQTT topic  */
                            this.mqtt.publish(topic, message, { qos: 2 })
                        }

                        /*  send "null" chunk to signal end of stream  */
                        const request = this.msg.makeResourceResponse(requestId, null, undefined, this.options.id, sender)
                        const message = this.codec.encode(request)
                        this.mqtt.publish(topic, message, { qos: 2 })
                    })
                    .catch((err: Error) => {
                        /*  generate corresponding MQTT topic  */
                        const topic = this.options.topicMake(resource, "resource-transfer-response", sender)

                        /*  send error  */
                        const request = this.msg.makeResourceResponse(requestId, null, err.message, this.options.id, sender)
                        const message = this.codec.encode(request)
                        this.mqtt.publish(topic, message, { qos: 2 })
                    })
            }
        }
        else if (topicMatch !== null
            && topicMatch.operation === "resource-transfer-response"
            && parsed instanceof ResourceResponse) {
            /*  handle resource response  */
            const requestId = parsed.id
            const error     = parsed.error
            let chunk     = parsed.chunk
            if (chunk !== null && chunk !== undefined && !Buffer.isBuffer(chunk))
                chunk = Buffer.from(chunk)
            const handler   = this.fetchCallback.get(requestId)
            handler?.callback(error ? new Error(error) : undefined, chunk)
        }
    }
}

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

/*  external requirements  */
import { IClientPublishOptions,
    IClientSubscribeOptions }        from "mqtt"
import { nanoid }                    from "nanoid"

/*  internal requirements  */
import {
    ServiceRequest,
    ServiceResponseSuccess,
    ServiceResponseError }           from "./mqtt-plus-msg"
import { APISchema, ServiceKeys }    from "./mqtt-plus-api"
import type { Receiver, WithInfo,
    InfoService, Registration }      from "./mqtt-plus-base"
import { StreamTrait }               from "./mqtt-plus-stream"

/*  Service Communication Trait  */
export class ServiceTrait<T extends APISchema = APISchema> extends StreamTrait<T> {
    /*  service state  */
    private requests      = new Map<string, { service: string, callback: (err: any, result: any) => void }>()
    private subscriptions = new Map<string, number>()

    /*  register an RPC service  */
    async register<K extends ServiceKeys<T> & string> (
        service:  K,
        callback: WithInfo<T[K], InfoService>
    ): Promise<Registration>
    async register<K extends ServiceKeys<T> & string> (
        service:  K,
        options:  Partial<IClientSubscribeOptions>,
        callback: WithInfo<T[K], InfoService>
    ): Promise<Registration>
    async register<K extends ServiceKeys<T> & string> (
        service:  K,
        ...args:  any[]
    ): Promise<Registration> {
        /*  determine parameters  */
        let options:  Partial<IClientSubscribeOptions> = {}
        let callback: T[K] = args[0] as T[K]
        if (args.length === 2 && typeof args[0] === "object") {
            options  = args[0]
            callback = args[1]
        }

        /*  sanity check situation  */
        if (this.registry.has(service))
            throw new Error(`register: service "${service}" already registered`)

        /*  generate the corresponding MQTT topics for broadcast and direct use  */
        const topicB = this.options.topicServiceRequestMake(service)
        const topicD = this.options.topicServiceRequestMake(service, this.options.id)

        /*  subscribe to MQTT topics  */
        await Promise.all([
            this._subscribeTopic(topicB, { qos: 2, ...options }),
            this._subscribeTopic(topicD, { qos: 2, ...options })
        ]).catch((err: Error) => {
            this._unsubscribeTopic(topicB).catch(() => {})
            this._unsubscribeTopic(topicD).catch(() => {})
            throw err
        })

        /*  remember the registration  */
        this.registry.set(service, callback)

        /*  provide a registration for subsequent unregistering  */
        const self = this
        const registration: Registration = {
            async unregister (): Promise<void> {
                if (!self.registry.has(service))
                    throw new Error(`unregister: service "${service}" not registered`)
                self.registry.delete(service)
                return Promise.all([
                    self._unsubscribeTopic(topicB),
                    self._unsubscribeTopic(topicD)
                ]).then(() => {})
            }
        }
        return registration
    }

    /*  call service ("request and response")  */
    call<K extends ServiceKeys<T> & string> (
        service:   K,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    call<K extends ServiceKeys<T> & string> (
        service:   K,
        receiver:  Receiver,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    call<K extends ServiceKeys<T> & string> (
        service:   K,
        options:   IClientPublishOptions,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    call<K extends ServiceKeys<T> & string> (
        service:   K,
        receiver:  Receiver,
        options:   IClientPublishOptions,
        ...params: Parameters<T[K]>
    ): Promise<Awaited<ReturnType<T[K]>>>
    call<K extends ServiceKeys<T> & string> (
        service:   K,
        ...args:   any[]
    ): Promise<Awaited<ReturnType<T[K]>>> {
        /*  determine actual parameters  */
        const { receiver, options, params } = this._parseCallArgs(args)

        /*  generate unique request id  */
        const rid = nanoid()

        /*  subscribe to MQTT response topic  */
        this._responseSubscribe(service, { qos: options.qos ?? 2 })

        /*  create promise for MQTT response handling  */
        const promise: Promise<Awaited<ReturnType<T[K]>>> = new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                this.requests.delete(rid)
                this._responseUnsubscribe(service)
                timer = null
                reject(new Error("communication timeout"))
            }, this.options.timeout)
            this.requests.set(rid, {
                service,
                callback: (err: any, result: Awaited<ReturnType<T[K]>>) => {
                    if (timer !== null) {
                        clearTimeout(timer)
                        timer = null
                    }
                    if (err) reject(err)
                    else     resolve(result)
                }
            })
        })

        /*  generate encoded message  */
        const request = this.msg.makeServiceRequest(rid, service, params, this.options.id, receiver)
        const message = this.codec.encode(request)

        /*  generate corresponding MQTT topic  */
        const topic = this.options.topicServiceRequestMake(service, receiver)

        /*  publish message to MQTT topic  */
        this.mqtt.publish(topic, message, { qos: 2, ...options }, (err?: Error) => {
            /*  handle request failure  */
            const pendingRequest = this.requests.get(rid)
            if (err && pendingRequest !== undefined) {
                this.requests.delete(rid)
                this._responseUnsubscribe(service)
                pendingRequest.callback(err, undefined)
            }
        })

        return promise
    }

    /*  subscribe to RPC response  */
    private _responseSubscribe (service: string, options: IClientSubscribeOptions = { qos: 2 }): void {
        /*  generate corresponding MQTT topic  */
        const topic = this.options.topicServiceResponseMake(service, this.options.id)

        /*  subscribe to MQTT topic and remember subscription  */
        if (!this.subscriptions.has(topic)) {
            this.subscriptions.set(topic, 0)
            this.mqtt.subscribe(topic, options, (err: Error | null) => {
                if (err)
                    this.mqtt.emit("error", err)
            })
        }
        this.subscriptions.set(topic, this.subscriptions.get(topic)! + 1)
    }

    /*  unsubscribe from RPC response  */
    private _responseUnsubscribe (service: string): void {
        /*  generate corresponding MQTT topic  */
        const topic = this.options.topicServiceResponseMake(service, this.options.id)

        /*  short-circuit processing if (no longer) subscribed  */
        if (!this.subscriptions.has(topic))
            return

        /*  unsubscribe from MQTT topic and forget subscription  */
        this.subscriptions.set(topic, this.subscriptions.get(topic)! - 1)
        if (this.subscriptions.get(topic) === 0) {
            this.subscriptions.delete(topic)
            this.mqtt.unsubscribe(topic, (err?: Error) => {
                if (err)
                    this.mqtt.emit("error", err)
            })
        }
    }

    /*  dispatch message (Service pattern handling)  */
    protected _dispatchMessage (parsed: any): boolean {
        if (parsed instanceof ServiceRequest) {
            /*  deliver service request and send response  */
            const rid = parsed.id
            const name = parsed.service
            const handler = this.registry.get(name)
            let response: Promise<any>
            if (handler !== undefined) {
                /*  execute service handler  */
                const params = parsed.params ?? []
                const info: InfoService = { sender: parsed.sender ?? "", receiver: parsed.receiver }
                response = Promise.resolve().then(() => handler(...params, info))
            }
            else
                response = Promise.reject(new Error(`method not found: ${name}`))
            response.then((result: any) => {
                /*  create success response  */
                return this.msg.makeServiceResponseSuccess(rid, result, this.options.id, parsed.sender)
            }, (result: any) => {
                /*  determine error message and build error response  */
                let errorMessage: string
                if (result === undefined || result === null)
                    errorMessage = "undefined error"
                else if (typeof result === "string")
                    errorMessage = result
                else if (result instanceof Error)
                    errorMessage = result.message
                else
                    errorMessage = String(result)
                return this.msg.makeServiceResponseError(rid, errorMessage, this.options.id, parsed.sender)
            }).then((rpcResponse) => {
                /*  send response message  */
                const senderPeerId = parsed.sender
                if (senderPeerId === undefined)
                    throw new Error("invalid request: missing sender")
                const encoded = this.codec.encode(rpcResponse)
                const topic = this.options.topicServiceResponseMake(name, senderPeerId)
                this.mqtt.publish(topic, encoded, { qos: 2 })
            }).catch((err: Error) => {
                this.mqtt.emit("error", err)
            })
            return true
        }
        else if (parsed instanceof ServiceResponseSuccess || parsed instanceof ServiceResponseError) {
            /*  handle service response  */
            const rid = parsed.id
            const request = this.requests.get(rid)
            if (request !== undefined) {
                /*  call callback function  */
                if (parsed instanceof ServiceResponseSuccess)
                    request.callback(undefined, parsed.result)
                else if (parsed instanceof ServiceResponseError)
                    request.callback(new Error(parsed.error), undefined)

                /*  unsubscribe from response  */
                this.requests.delete(rid)
                this._responseUnsubscribe(request.service)
            }
            return true
        }
        return super._dispatchMessage(parsed)
    }
}

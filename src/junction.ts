/*
**  MQTT-JSON-RPC -- JSON-RPC protocol over MQTT communication
**  Copyright (c) 2018-2025 Dr. Ralf S. Engelschall <rse@engelschall.com>
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
import { MqttClient, IClientPublishOptions,
    IClientSubscribeOptions }                from "mqtt"
import { nanoid }                            from "nanoid"

/*  internal requirements  */
import Codec                                 from "./junction-codec"
import Msg, {
    EventEmission,
    ServiceRequest,
    ServiceResponseSuccess,
    ServiceResponseError }                   from "./junction-msg"

/*  type of a wrapped receiver id (for method overloading)  */
export type Receiver = { __receiver: string }

/*  MQTT topic making  */
export type TopicMake = (name: string, peerId?: string) => string

/*  MQTT topic matching  */
export type TopicMatch    = (topic: string) => TopicMatching | null
export type TopicMatching = { name: string, peerId?: string }

/*  API option type  */
export interface APIOptions {
    id:                        string
    codec:                     "cbor" | "json"
    timeout:                   number
    topicEventNoticeMake:      TopicMake
    topicServiceRequestMake:   TopicMake
    topicServiceResponseMake:  TopicMake
    topicEventNoticeMatch:     TopicMatch
    topicServiceRequestMatch:  TopicMatch
    topicServiceResponseMatch: TopicMatch
}

/*  Registration, Subscription and Observation result types  */
export interface Registration {
    unregister (): Promise<void>
}
export interface Subscription {
    unsubscribe (): Promise<void>
}

/*  callback info type  */
export interface Info {
    sender:    string,
    receiver?: string
}

/*  type utility: extend function with Info parameter  */
export type WithInfo<F> = F extends (...args: infer P) => infer R
    ? (...args: [ ...P, info: Info ]) => R
    : never

/*  type utilities for generic API  */
export type APISchema = Record<string, (...args: any[]) => any>

/*  extract event keys where return type IS void (events: subscribe/notify/control)  */
export type EventKeys<T> = string extends keyof T ? string : {
    [ K in keyof T ]: T[K] extends (...args: any[]) => infer R
    /*  eslint-disable-next-line @typescript-eslint/no-invalid-void-type  */
    ? [ R ] extends [ void ] ? K : never
    : never
}[ keyof T ]

/*  extract service keys where return type is NOT void (services: register/call)  */
export type ServiceKeys<T> = string extends keyof T ? string : {
    [ K in keyof T ]: T[K] extends (...args: any[]) => infer R
    /*  eslint-disable-next-line @typescript-eslint/no-invalid-void-type  */
    ? [ R ] extends [ void ] ? never : K
    : never
}[ keyof T ]

/*  Junction API class  */
export default class Junction<T extends APISchema = APISchema> {
    private options:      APIOptions
    private codec:        Codec
    private msg           = new Msg()
    private registry      = new Map<string, ((...params: any[]) => any) | ((...params: any[]) => void)>()
    private requests      = new Map<string, { service: string, callback: (err: any, result: any) => void }>()
    private subscriptions = new Map<string, number>()

    /*  construct API class  */
    constructor (
        private mqtt: MqttClient,
        options: Partial<APIOptions> = {}
    ) {
        /*  determine options and provide defaults  */
        this.options = {
            id:       nanoid(),
            codec:    "cbor",
            timeout:  10 * 1000,
            topicEventNoticeMake: (name, peerId) => {
                return peerId
                    ? `${name}/event-notice/${peerId}`
                    : `${name}/event-notice`
            },
            topicServiceRequestMake: (name, peerId) => {
                return peerId
                    ? `${name}/service-request/${peerId}`
                    : `${name}/service-request`
            },
            topicServiceResponseMake: (name, peerId) => {
                return peerId
                    ? `${name}/service-response/${peerId}`
                    : `${name}/service-response`
            },
            topicEventNoticeMatch: (topic) => {
                const m = topic.match(/^(.+?)\/event-notice(?:\/(.+))?$/)
                return m ? { name: m[1], peerId: m[2] } : null
            },
            topicServiceRequestMatch: (topic) => {
                const m = topic.match(/^(.+?)\/service-request(?:\/(.+))?$/)
                return m ? { name: m[1], peerId: m[2] } : null
            },
            topicServiceResponseMatch: (topic) => {
                const m = topic.match(/^(.+?)\/service-response\/(.+)$/)
                return m ? { name: m[1], peerId: m[2] } : null
            },
            ...options
        }

        /*  establish an encoder  */
        this.codec = new Codec(this.options.codec)

        /*  hook into the MQTT message processing  */
        this.mqtt.on("message", (topic, message) => {
            this._onMessage(topic, message)
        })
    }

    /*  subscribe to an MQTT topic (Promise-based)  */
    private async _subscribeTopic (topic: string, options: Partial<IClientSubscribeOptions> = {}) {
        return new Promise<void>((resolve, reject) => {
            this.mqtt.subscribe(topic, { qos: 2, ...options }, (err: Error | null, _granted: any) => {
                if (err) reject(err)
                else     resolve()
            })
        })
    }

    /*  unsubscribe from an MQTT topic (Promise-based)  */
    private async _unsubscribeTopic (topic: string) {
        return new Promise<void>((resolve, reject) => {
            this.mqtt.unsubscribe(topic, (err?: Error, _packet?: any) => {
                if (err) reject(err)
                else     resolve()
            })
        })
    }

    /*  subscribe to an RPC event  */
    async subscribe<K extends EventKeys<T> & string> (
        event:    K,
        callback: WithInfo<T[K]>
    ): Promise<Subscription>
    async subscribe<K extends EventKeys<T> & string> (
        event:    K,
        options:  Partial<IClientSubscribeOptions>,
        callback: WithInfo<T[K]>
    ): Promise<Subscription>
    async subscribe<K extends EventKeys<T> & string> (
        event:    K,
        ...args:  any[]
    ): Promise<Subscription> {
        /*  determine parameters  */
        let options:  Partial<IClientSubscribeOptions> = {}
        let callback: T[K] = args[0] as T[K]
        if (args.length === 2 && typeof args[0] === "object") {
            options  = args[0]
            callback = args[1]
        }

        /*  sanity check situation  */
        if (this.registry.has(event))
            throw new Error(`subscribe: event "${event}" already subscribed`)

        /*  generate the corresponding MQTT topics for broadcast and direct use  */
        const topicB = this.options.topicEventNoticeMake(event)
        const topicD = this.options.topicEventNoticeMake(event, this.options.id)

        /*  subscribe to MQTT topics  */
        await Promise.all([
            this._subscribeTopic(topicB, { qos: 0, ...options }),
            this._subscribeTopic(topicD, { qos: 0, ...options })
        ]).catch((err: Error) => {
            this._unsubscribeTopic(topicB).catch(() => {})
            this._unsubscribeTopic(topicD).catch(() => {})
            throw err
        })

        /*  remember the subscription  */
        this.registry.set(event, callback)

        /*  provide a subscription for subsequent unsubscribing  */
        const self = this
        const subscription: Subscription = {
            async unsubscribe (): Promise<void> {
                if (!self.registry.has(event))
                    throw new Error(`unsubscribe: event "${event}" not subscribed`)
                self.registry.delete(event)
                return Promise.all([
                    self._unsubscribeTopic(topicB),
                    self._unsubscribeTopic(topicD)
                ]).then(() => {})
            }
        }
        return subscription
    }

    /*  register an RPC service  */
    async register<K extends ServiceKeys<T> & string> (
        service:  K,
        callback: WithInfo<T[K]>
    ): Promise<Registration>
    async register<K extends ServiceKeys<T> & string> (
        service:  K,
        options:  Partial<IClientSubscribeOptions>,
        callback: WithInfo<T[K]>
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

    /*  check whether argument has structure of interface IClientPublishOptions  */
    private _isIClientPublishOptions (arg: any) {
        if (typeof arg !== "object")
            return false
        const keys = [ "qos", "retain", "dup", "properties", "cbStorePut" ]
        return Object.keys(arg).every((key) => keys.includes(key))
    }

    /*  wrap receiver id into object (required for type-safe overloading)  */
    receiver (id: string) {
        return { __receiver: id }
    }

    /*  return client id from wrapper object  */
    private _getReceiver (obj: Receiver) {
        return obj.__receiver
    }

    /*  detect client id wrapper object  */
    private _isReceiver (obj: any): obj is Receiver {
        return (typeof obj === "object"
            && obj !== null
            && "__receiver" in obj
            && typeof obj.__receiver === "string"
        )
    }

    /*  parse optional peerId and options from variadic arguments  */
    private _parseCallArgs<T extends any[]> (args: any[]): { receiver?: string, options: IClientPublishOptions, params: T } {
        let receiver: string | undefined
        let options: IClientPublishOptions = {}
        let params = args as T
        if (args.length >= 2 && this._isReceiver(args[0]) && this._isIClientPublishOptions(args[1])) {
            receiver = this._getReceiver(args[0])
            options  = args[1]
            params   = args.slice(2) as T
        }
        else if (args.length >= 1 && this._isReceiver(args[0])) {
            receiver = this._getReceiver(args[0])
            params   = args.slice(1) as T
        }
        else if (args.length >= 1 && this._isIClientPublishOptions(args[0])) {
            options = args[0]
            params  = args.slice(1) as T
        }
        return { receiver, options, params }
    }

    /*  emit event ("fire and forget")  */
    emit<K extends EventKeys<T> & string> (
        event:     K,
        ...params: Parameters<T[K]>
    ): void
    emit<K extends EventKeys<T> & string> (
        event:     K,
        receiver:  Receiver,
        ...params: Parameters<T[K]>
    ): void
    emit<K extends EventKeys<T> & string> (
        event:     K,
        options:   IClientPublishOptions,
        ...params: Parameters<T[K]>
    ): void
    emit<K extends EventKeys<T> & string> (
        event:     K,
        receiver:  Receiver,
        options:   IClientPublishOptions,
        ...params: Parameters<T[K]>
    ): void
    emit<K extends EventKeys<T> & string> (
        event:     K,
        ...args:   any[]
    ): void {
        /*  determine actual parameters  */
        const { receiver, options, params } = this._parseCallArgs<Parameters<T[K]>>(args)

        /*  generate unique request id  */
        const rid = nanoid()

        /*  generate encoded Msg message  */
        const request = this.msg.makeEventEmission(rid, event, params, this.options.id, receiver)
        const message = this.codec.encode(request)

        /*  generate corresponding MQTT topic  */
        const topic = this.options.topicEventNoticeMake(event, receiver)

        /*  publish message to MQTT topic  */
        this.mqtt.publish(topic, message, { qos: 2, ...options })
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
        const { receiver, options, params } = this._parseCallArgs<Parameters<T[K]>>(args)

        /*  generate unique request id  */
        const rid = nanoid()

        /*  subscribe to MQTT response topic  */
        this._responseSubscribe(service, { qos: options.qos ?? 2 })

        /*  create promise for MQTT response handling  */
        const promise: Promise<Awaited<ReturnType<T[K]>>> = new Promise((resolve, reject) => {
            let timer: NodeJS.Timeout | null = setTimeout(() => {
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

    /*  handle incoming MQTT message  */
    private _onMessage (topic: string, message: Buffer): void {
        /*  ensure we handle only valid messages  */
        let eventMatch:    TopicMatching | null = null
        let requestMatch:  TopicMatching | null = null
        let responseMatch: TopicMatching | null = null
        if (   (eventMatch    = this.options.topicEventNoticeMatch(topic))     === null
            && (requestMatch  = this.options.topicServiceRequestMatch(topic))  === null
            && (responseMatch = this.options.topicServiceResponseMatch(topic)) === null)
            return

        /*  ensure we really handle only messages for us  */
        const peerId = eventMatch?.peerId ?? requestMatch?.peerId ?? responseMatch?.peerId
        if (peerId !== undefined && peerId !== this.options.id)
            return

        /*  try to parse payload as payload  */
        let parsed: EventEmission | ServiceRequest | ServiceResponseSuccess | ServiceResponseError
        try {
            let input: Buffer | string = message
            if (this.options.codec === "json")
                input = message.toString()
            const payload = this.codec.decode(input)
            parsed = this.msg.parse(payload)
        }
        catch (_err: unknown) {
            const err = _err instanceof Error
                ? new Error(`failed to parse message: ${_err.message}`)
                : new Error("failed to parse message")
            this.mqtt.emit("error", err)
            return
        }

        /*  dispatch according to message type  */
        if (parsed instanceof EventEmission) {
            /*  just deliver event  */
            const name = parsed.event
            const handler = this.registry.get(name)
            const params = parsed.params ?? []
            const info: Info = { sender: parsed.sender ?? "", receiver: parsed.receiver }
            handler?.(...params, info)
        }
        else if (parsed instanceof ServiceRequest) {
            /*  deliver service request and send response  */
            const rid = parsed.id
            const name = parsed.service
            const handler = this.registry.get(name)
            let response: Promise<any>
            if (handler !== undefined) {
                /*  execute service handler  */
                const params = parsed.params ?? []
                const info: Info = { sender: parsed.sender ?? "", receiver: parsed.receiver }
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
        }
    }
}


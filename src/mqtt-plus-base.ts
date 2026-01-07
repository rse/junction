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
import stream                                from "stream"
import { MqttClient, IClientPublishOptions,
    IClientSubscribeOptions }                from "mqtt"
import { nanoid }                            from "nanoid"

/*  internal requirements  */
import Codec                                 from "./mqtt-plus-codec"
import { APISchema, APIEndpoint }            from "./mqtt-plus-api"
import Msg, {
    EventEmission,
    StreamChunk,
    ServiceRequest,
    ServiceResponseSuccess,
    ServiceResponseError }                   from "./mqtt-plus-msg"

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
    chunkSize:                 number
    topicEventNoticeMake:      TopicMake
    topicStreamChunkMake:      TopicMake
    topicServiceRequestMake:   TopicMake
    topicServiceResponseMake:  TopicMake
    topicEventNoticeMatch:     TopicMatch
    topicStreamChunkMatch:     TopicMatch
    topicServiceRequestMatch:  TopicMatch
    topicServiceResponseMatch: TopicMatch
}

/*  type of a wrapped receiver id (for method overloading)  */
export type Receiver = { __receiver: string }

/*  Registration, Subscription and Observation result types  */
export interface Registration {
    unregister (): Promise<void>
}
export interface Attachment {
    unattach (): Promise<void>
}
export interface Subscription {
    unsubscribe (): Promise<void>
}

/*  info types  */
export interface InfoBase {
    sender:    string,
    receiver?: string
}
export interface InfoEvent   extends InfoBase {}
export interface InfoStream  extends InfoBase { stream: stream.Readable }
export interface InfoService extends InfoBase {}

/*  type utility: extend function with Info parameter  */
export type WithInfo<F, I extends InfoBase> = F extends (...args: infer P) => infer R
    ? (...args: [ ...P, info: I ]) => R
    : never

/*  MQTTp Base class with shared infrastructure  */
export class BaseTrait<T extends APISchema = APISchema> {
    protected mqtt:     MqttClient
    protected options:  APIOptions
    protected codec:    Codec
    protected msg       = new Msg()
    protected registry  = new Map<string, APIEndpoint>()

    /*  construct API class  */
    constructor (
        mqtt: MqttClient,
        options: Partial<APIOptions> = {}
    ) {
        /*  store MQTT client  */
        this.mqtt = mqtt

        /*  determine options and provide defaults  */
        this.options = {
            id:        nanoid(),
            codec:     "cbor",
            timeout:   10 * 1000,
            chunkSize: 16 * 1024,
            topicEventNoticeMake: (name, peerId) => {
                return peerId
                    ? `${name}/event-notice/${peerId}`
                    : `${name}/event-notice`
            },
            topicStreamChunkMake: (name, peerId) => {
                return peerId
                    ? `${name}/stream-chunk/${peerId}`
                    : `${name}/stream-chunk`
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
            topicStreamChunkMatch: (topic) => {
                const m = topic.match(/^(.+?)\/stream-chunk(?:\/(.+))?$/)
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
    protected async _subscribeTopic (topic: string, options: Partial<IClientSubscribeOptions> = {}) {
        return new Promise<void>((resolve, reject) => {
            this.mqtt.subscribe(topic, { qos: 2, ...options }, (err: Error | null, _granted: any) => {
                if (err) reject(err)
                else     resolve()
            })
        })
    }

    /*  unsubscribe from an MQTT topic (Promise-based)  */
    protected async _unsubscribeTopic (topic: string) {
        return new Promise<void>((resolve, reject) => {
            this.mqtt.unsubscribe(topic, (err?: Error, _packet?: any) => {
                if (err) reject(err)
                else     resolve()
            })
        })
    }

    /*  check whether argument has structure of interface IClientPublishOptions  */
    protected _isIClientPublishOptions (arg: any) {
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
    protected _getReceiver (obj: Receiver) {
        return obj.__receiver
    }

    /*  detect client id wrapper object  */
    protected _isReceiver (obj: any): obj is Receiver {
        return (typeof obj === "object"
            && obj !== null
            && "__receiver" in obj
            && typeof obj.__receiver === "string"
        )
    }

    /*  parse optional peerId and options from variadic arguments  */
    protected _parseCallArgs<U extends any[]> (args: any[]): { receiver?: string, options: IClientPublishOptions, params: U } {
        let receiver: string | undefined
        let options: IClientPublishOptions = {}
        let params = args as U
        if (args.length >= 2 && this._isReceiver(args[0]) && this._isIClientPublishOptions(args[1])) {
            receiver = this._getReceiver(args[0])
            options  = args[1]
            params   = args.slice(2) as U
        }
        else if (args.length >= 1 && this._isReceiver(args[0])) {
            receiver = this._getReceiver(args[0])
            params   = args.slice(1) as U
        }
        else if (args.length >= 1 && this._isIClientPublishOptions(args[0])) {
            options = args[0]
            params  = args.slice(1) as U
        }
        return { receiver, options, params }
    }

    /*  dispatch parsed message to appropriate handler (base implementation)  */
    protected _dispatchMessage (_parsed: any): boolean {
        return false
    }

    /*  handle incoming MQTT message  */
    private _onMessage (topic: string, message: Buffer): void {
        /*  ensure we handle only valid messages  */
        let eventMatch:    TopicMatching | null = null
        let streamMatch:   TopicMatching | null = null
        let requestMatch:  TopicMatching | null = null
        let responseMatch: TopicMatching | null = null
        if (   (eventMatch    = this.options.topicEventNoticeMatch(topic))     === null
            && (streamMatch   = this.options.topicStreamChunkMatch(topic))     === null
            && (requestMatch  = this.options.topicServiceRequestMatch(topic))  === null
            && (responseMatch = this.options.topicServiceResponseMatch(topic)) === null)
            return

        /*  ensure we really handle only messages for us  */
        const peerId = eventMatch?.peerId ??
            streamMatch?.peerId ??
            requestMatch?.peerId ??
            responseMatch?.peerId
        if (peerId !== undefined && peerId !== this.options.id)
            return

        /*  try to parse payload as payload  */
        let parsed: EventEmission | StreamChunk | ServiceRequest | ServiceResponseSuccess | ServiceResponseError
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

        /*  dispatch to trait handlers  */
        this._dispatchMessage(parsed)
    }
}

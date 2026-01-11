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
import { MqttClient, IClientPublishOptions,
    IClientSubscribeOptions,
    IPublishPacket }                         from "mqtt"

/*  internal requirements  */
import { APISchema }                         from "./mqtt-plus-api"
import { EventEmission, StreamChunk,
    ServiceRequest,
    ServiceResponse,
    ResourceRequest,
    ResourceResponse }                       from "./mqtt-plus-msg"
import { APIOptions }                        from "./mqtt-plus-options"
import { ReceiverTrait }                     from "./mqtt-plus-receiver"

/*  MQTTp Base class with shared infrastructure  */
export class BaseTrait<T extends APISchema = APISchema> extends ReceiverTrait<T> {
    protected mqtt: MqttClient

    /*  construct API class  */
    constructor (
        mqtt: MqttClient,
        options: Partial<APIOptions> = {}
    ) {
        super(options)

        /*  store MQTT client  */
        this.mqtt = mqtt

        /*  hook into the MQTT message processing  */
        this.mqtt.on("message", (topic, message, packet) => {
            this._onMessage(topic, message, packet)
        })
    }

    /*  destroy API class  */
    destroy () {
        this.mqtt.removeAllListeners()
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
    private _isIClientPublishOptions (arg: any) {
        if (typeof arg !== "object")
            return false
        const keys = [ "qos", "retain", "dup", "properties", "cbStorePut" ]
        return Object.keys(arg).every((key) => keys.includes(key))
    }

    /*  parse optional peerId and options from variadic arguments  */
    protected _parseCallArgs<U extends any[]> (
        args: any[]
    ): {
        receiver?: string,
        options: IClientPublishOptions,
        params: U
    } {
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

    /*  handle incoming MQTT message  */
    private _onMessage (topic: string, message: Buffer, packet: IPublishPacket): void {
        /*  try to parse payload as payload  */
        let parsed:
            EventEmission     |
            StreamChunk       |
            ServiceRequest    |
            ServiceResponse   |
            ResourceRequest   |
            ResourceResponse
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
        this._dispatchMessage(topic, parsed)
    }

    /*  dispatch parsed message to appropriate handler
        (base implementation, to be overridden in super-traits)  */
    protected _dispatchMessage (
        _topic:  string,
        _parsed: any
    ): void {}
}

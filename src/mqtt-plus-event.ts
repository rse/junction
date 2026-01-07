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
import { EventEmission }             from "./mqtt-plus-msg"
import { APISchema, EventKeys }      from "./mqtt-plus-api"
import type { Receiver, WithInfo,
    InfoEvent, Subscription }        from "./mqtt-plus-base"
import { BaseTrait }                 from "./mqtt-plus-base"

/*  Event Communication Trait  */
export class EventTrait<T extends APISchema = APISchema> extends BaseTrait<T> {
    /*  subscribe to an RPC event  */
    async subscribe<K extends EventKeys<T> & string> (
        event:    K,
        callback: WithInfo<T[K], InfoEvent>
    ): Promise<Subscription>
    async subscribe<K extends EventKeys<T> & string> (
        event:    K,
        options:  Partial<IClientSubscribeOptions>,
        callback: WithInfo<T[K], InfoEvent>
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
        const { receiver, options, params } = this._parseCallArgs(args)

        /*  generate unique request id  */
        const rid = nanoid()

        /*  generate encoded message  */
        const request = this.msg.makeEventEmission(rid, event, params, this.options.id, receiver)
        const message = this.codec.encode(request)

        /*  generate corresponding MQTT topic  */
        const topic = this.options.topicEventNoticeMake(event, receiver)

        /*  publish message to MQTT topic  */
        this.mqtt.publish(topic, message, { qos: 2, ...options })
    }

    /*  dispatch message (Event pattern handling)  */
    protected _dispatchMessage (parsed: any): boolean {
        if (parsed instanceof EventEmission) {
            /*  just deliver event  */
            const name = parsed.event
            const handler = this.registry.get(name)
            const params = parsed.params ?? []
            const info: InfoEvent = { sender: parsed.sender ?? "", receiver: parsed.receiver }
            handler?.(...params, info)
            return true
        }
        return super._dispatchMessage(parsed)
    }
}

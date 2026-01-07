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
import stream                        from "stream"

/*  external requirements  */
import { IClientPublishOptions,
    IClientSubscribeOptions }        from "mqtt"
import { nanoid }                    from "nanoid"

/*  internal requirements  */
import { StreamChunk }               from "./mqtt-plus-msg"
import { APISchema, StreamKeys }     from "./mqtt-plus-api"
import type { Receiver, WithInfo,
    InfoStream, Attachment }         from "./mqtt-plus-base"
import { EventTrait }                from "./mqtt-plus-event"

/*  Stream Communication Trait  */
export class StreamTrait<T extends APISchema> extends EventTrait<T> {
    /*  stream state  */
    private streams = new Map<string, stream.Readable>()

    /*  attach to a stream  */
    async attach<K extends StreamKeys<T> & string> (
        streamName: K,
        callback:   WithInfo<T[K], InfoStream>
    ): Promise<Attachment>
    async attach<K extends StreamKeys<T> & string> (
        streamName: K,
        options:    Partial<IClientSubscribeOptions>,
        callback:   WithInfo<T[K], InfoStream>
    ): Promise<Attachment>
    async attach<K extends StreamKeys<T> & string> (
        streamName: K,
        ...args:    any[]
    ): Promise<Attachment> {
        /*  determine parameters  */
        let options:  Partial<IClientSubscribeOptions> = {}
        let callback: T[K] = args[0] as T[K]
        if (args.length === 2 && typeof args[0] === "object") {
            options  = args[0]
            callback = args[1]
        }

        /*  sanity check situation  */
        if (this.registry.has(streamName))
            throw new Error(`attach: stream "${streamName}" already attached`)

        /*  generate the corresponding MQTT topics for broadcast and direct use  */
        const topicB = this.options.topicStreamChunkMake(streamName)
        const topicD = this.options.topicStreamChunkMake(streamName, this.options.id)

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
        this.registry.set(streamName, callback)

        /*  provide an attachment for subsequent unattaching  */
        const self = this
        const attachment: Attachment = {
            async unattach (): Promise<void> {
                if (!self.registry.has(streamName))
                    throw new Error(`unattach: stream "${streamName}" not attached`)
                self.registry.delete(streamName)
                return Promise.all([
                    self._unsubscribeTopic(topicB),
                    self._unsubscribeTopic(topicD)
                ]).then(() => {})
            }
        }
        return attachment
    }

    /*  transfer stream ("chunked content")  */
    transfer<K extends StreamKeys<T> & string> (
        streamName: K,
        readable:   stream.Readable,
        ...params:  Parameters<T[K]>
    ): Promise<void>
    transfer<K extends StreamKeys<T> & string> (
        streamName: K,
        readable:   stream.Readable,
        receiver:   Receiver,
        ...params:  Parameters<T[K]>
    ): Promise<void>
    transfer<K extends StreamKeys<T> & string> (
        streamName: K,
        readable:   stream.Readable,
        options:    IClientPublishOptions,
        ...params:  Parameters<T[K]>
    ): Promise<void>
    transfer<K extends StreamKeys<T> & string> (
        streamName: K,
        readable:   stream.Readable,
        receiver:   Receiver,
        options:    IClientPublishOptions,
        ...params:  Parameters<T[K]>
    ): Promise<void>
    transfer<K extends StreamKeys<T> & string> (
        streamName: K,
        readable:   stream.Readable,
        ...args:    any[]
    ): Promise<void> {
        /*  determine actual parameters  */
        const { receiver, options, params } = this._parseCallArgs(args)

        /*  generate unique request id  */
        const rid = nanoid()

        /*  generate corresponding MQTT topic  */
        const topic = this.options.topicStreamChunkMake(streamName, receiver)

        /*  utility function for converting a chunk to a Buffer  */
        const chunkToBuffer = (chunk: any) => {
            let buffer: Buffer
            if (Buffer.isBuffer(chunk))
                buffer = chunk
            else if (typeof chunk === "string")
                buffer = Buffer.from(chunk)
            else if (chunk instanceof Uint8Array)
                buffer = Buffer.from(chunk)
            else
                buffer = Buffer.from(String(chunk))
            return buffer
        }

        /*  iterate over all chunks of the buffer  */
        return new Promise((resolve, reject) => {
            readable.on("readable", () => {
                let chunk: any
                while ((chunk = readable.read(this.options.chunkSize)) !== null) {
                    /*  ensure data is a Buffer  */
                    const buffer = chunkToBuffer(chunk)

                    /*  generate encoded message  */
                    const request = this.msg.makeStreamChunk(rid, streamName, buffer, params, this.options.id, receiver)
                    const message = this.codec.encode(request)

                    /*  publish message to MQTT topic  */
                    this.mqtt.publish(topic, message, { qos: 2, ...options })
                }
            })
            readable.on("end", () => {
                /*  send "null" chunk to signal end of stream  */
                const request = this.msg.makeStreamChunk(rid, streamName, null, params, this.options.id, receiver)
                const message = this.codec.encode(request)
                this.mqtt.publish(topic, message, { qos: 2, ...options })
                resolve()
            })
            readable.on("error", () => {
                reject(new Error("readable stream error"))
            })
        })
    }

    /*  dispatch message (Stream pattern handling)  */
    protected _dispatchMessage (parsed: any): boolean {
        if (parsed instanceof StreamChunk) {
            /*  just handle stream chunk  */
            const id  = parsed.id
            let chunk = parsed.chunk
            let readable = this.streams.get(id)
            if (readable === undefined) {
                const name    = parsed.stream
                const params  = parsed.params ?? []
                readable = new stream.Readable({ read (_size) {} })
                this.streams.set(id, readable)
                const info: InfoStream = { sender: parsed.sender ?? "", receiver: parsed.receiver, stream: readable }
                const handler = this.registry.get(name)
                handler?.(...params, info)
            }
            if (chunk !== null && !Buffer.isBuffer(chunk))
                chunk = Buffer.from(chunk)
            readable.push(chunk)
            if (chunk === null)
                this.streams.delete(id)
            return true
        }
        return super._dispatchMessage(parsed)
    }
}

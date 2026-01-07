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
import { nanoid }      from "nanoid"

/*  internal requirements  */
import { APISchema }   from "./mqtt-plus-api"

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

/*  Options trait  */
export class OptionsTrait<T extends APISchema = APISchema> {
    protected options: APIOptions

    /*  construct API class  */
    constructor (
        options: Partial<APIOptions> = {}
    ) {
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
    }
}

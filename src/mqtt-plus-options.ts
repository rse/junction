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

/*  MQTT topic matching  */
export type TopicMake     = (name: string, operation: string, peerId?: string) => string
export type TopicMatch    = (topic: string) => TopicMatching | null
export type TopicMatching = { name: string, operation: string, peerId?: string }

/*  API option type  */
export interface APIOptions {
    id:                         string
    codec:                      "cbor" | "json"
    timeout:                    number
    chunkSize:                  number
    topicMake:                  TopicMake
    topicMatch:                 TopicMatch
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
            topicMake: (name, protocol, peerId) => {
                return `${name}/${protocol}` + (peerId ? `/${peerId}` : "/any")
            },
            topicMatch: (topic) => {
                const m = topic.match(/^(.+)\/([^/]+)\/([^/]+)$/)
                return m ? { name: m[1], operation: m[2], peerId: m[3] === "any" ? undefined : m[3] } : null
            },
            ...options
        }
    }
}

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
import CBOR from "cbor"

/*  internal requirements  */
import { APISchema }                 from "./mqtt-plus-api"
import { APIOptions, OptionsTrait }  from "./mqtt-plus-options"

/*  the encoder/decoder abstraction  */
export default class Codec {
    constructor (private type: "cbor" | "json") {}
    encode (data: unknown): Buffer | string {
        let result: Buffer | string
        if (this.type === "cbor") {
            try { result = CBOR.encode(data) }
            catch (_ex) { throw new Error("failed to encode CBOR format") }
        }
        else if (this.type === "json") {
            try { result = JSON.stringify(data) }
            catch (_ex) { throw new Error("failed to encode JSON format") }
        }
        else
            throw new Error("invalid format")
        return result
    }
    decode (data: Buffer | string): unknown {
        let result: unknown
        if (this.type === "cbor" && typeof data === "object" && data instanceof Buffer) {
            try { result = CBOR.decode(data) }
            catch (_ex) { throw new Error("failed to decode CBOR format") }
        }
        else if (this.type === "json" && typeof data === "string") {
            try { result = JSON.parse(data) }
            catch (_ex) { throw new Error("failed to decode JSON format") }
        }
        else
            throw new Error("invalid format or wrong data type")
        return result
    }
}

/*  Codec trait  */
export class CodecTrait<T extends APISchema = APISchema> extends OptionsTrait<T> {
    protected codec: Codec

    /*  construct API class  */
    constructor(
        options: Partial<APIOptions> = {}
    ) {
        super(options)

        /*  establish a codec  */
        this.codec = new Codec(this.options.codec)
    }
}


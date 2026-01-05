/*
**  Junction -- MQTT Communication Junction
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
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

/*  base class  */
export class Base {
    constructor (
        public id:        string,
        public sender?:   string,
        public receiver?: string
    ) {}
}

/*  event emission  */
export class EventEmission extends Base {
    constructor (
        id:             string,
        public event:   string,
        public params?: any[],
        sender?:        string,
        receiver?:      string,
    ) { super(id, sender, receiver) }
}

/*  service request  */
export class ServiceRequest extends Base {
    constructor (
        id:             string,
        public service: string,
        public params?: any[],
        sender?:        string,
        receiver?:      string,
    ) { super(id, sender, receiver) }
}

/*  service response success  */
export class ServiceResponseSuccess extends Base {
    constructor (
        id:             string,
        public result:  any,
        sender?:        string,
        receiver?:      string
    ) { super(id, sender, receiver) }
}

/*  service response error  */
export class ServiceResponseError extends Base {
    constructor (
        id:             string,
        public error:   string,
        sender?:        string,
        receiver?:      string
    ) { super(id, sender, receiver) }
}

/*  utility class  */
export default class Msg {
    /*  factory for event emission  */
    makeEventEmission (
        id:             string,
        event:          string,
        params?:        any[],
        sender?:        string,
        receiver?:      string
    ): EventEmission {
        return new EventEmission(id, event, params, sender, receiver)
    }

    /*  factory for service request  */
    makeServiceRequest (
        id:             string,
        service:        string,
        params?:        any[],
        sender?:        string,
        receiver?:      string
    ): ServiceRequest {
        return new ServiceRequest(id, service, params, sender, receiver)
    }

    /*  factory for service response success  */
    makeServiceResponseSuccess (
        id:             string,
        result:         any,
        sender?:        string,
        receiver?:      string
    ): ServiceResponseSuccess {
        return new ServiceResponseSuccess(id, result, sender, receiver)
    }

    /*  factory for service response error  */
    makeServiceResponseError (
        id:             string,
        error:          string,
        sender?:        string,
        receiver?:      string
    ): ServiceResponseError {
        return new ServiceResponseError(id, error, sender, receiver)
    }

    /*  parse any object into typed object  */
    parse (obj: any): EventEmission | ServiceRequest | ServiceResponseSuccess | ServiceResponseError {
        if (typeof obj !== "object" || obj === null)
            throw new Error("invalid argument: not an object")

        /*  validate common fields  */
        if (!("id" in obj) || typeof obj.id !== "string")
            throw new Error("invalid object: missing or invalid \"id\" field")
        if ("sender" in obj && typeof obj.sender !== "string")
            throw new Error("invalid object: invalid \"sender\" field")
        if ("receiver" in obj && typeof obj.sender !== "string")
            throw new Error("invalid object: invalid \"receiver\" field")

        /*  dispatch according to type indication by field  */
        const anyFieldsExcept = (obj: object, allowed: string[]) =>
            Object.keys(obj).some((key) => !allowed.includes(key))
        if ("event" in obj) {
            /*  detect and parse event emission  */
            if (typeof obj.event !== "string")
                throw new Error("invalid EventEmission object: \"event\" field must be a string")
            if (anyFieldsExcept(obj, [ "type", "id", "event", "params", "sender", "receiver" ]))
                throw new Error("invalid EventEmission object: contains unknown fields")
            if (obj.params !== undefined && (typeof obj.params !== "object" || !Array.isArray(obj.params)))
                throw new Error("invalid EventEmission object: \"params\" field must be an array")
            return this.makeEventEmission(obj.id, obj.event, obj.params, obj.sender, obj.receiver)
        }
        else if ("service" in obj) {
            /*  detect and parse service request  */
            if (typeof obj.service !== "string")
                throw new Error("invalid ServiceRequest object: \"service\" field must be a string")
            if (anyFieldsExcept(obj, [ "type", "id", "service", "params", "sender", "receiver" ]))
                throw new Error("invalid ServiceRequest object: contains unknown fields")
            if (obj.params !== undefined && (typeof obj.params !== "object" || !Array.isArray(obj.params)))
                throw new Error("invalid ServiceRequest object: \"params\" field must be an array")
            return this.makeServiceRequest(obj.id, obj.service, obj.params, obj.sender, obj.receiver)
        }
        else if ("result" in obj) {
            /*  detect and parse service response success  */
            if (anyFieldsExcept(obj, [ "type", "id", "result", "sender", "receiver" ]))
                throw new Error("invalid ServiceResponseSuccess object: contains unknown fields")
            return this.makeServiceResponseSuccess(obj.id, obj.result, obj.sender, obj.receiver)
        }
        else if ("error" in obj) {
            /*  detect and parse service response error  */
            if (anyFieldsExcept(obj, [ "type", "id", "error", "sender", "receiver" ]))
                throw new Error("invalid ServiceResponseError object: contains unknown fields")
            return this.makeServiceResponseError(obj.id, obj.error, obj.sender, obj.receiver)
        }
        else
            throw new Error("invalid object: not of any known type")
    }
}

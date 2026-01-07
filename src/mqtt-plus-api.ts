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

/*  utility type for branding  */
type Brand<T> = T & { readonly __brand: unique symbol }

/*  API marker types  */
export type APIEndpoint = ((...args: any[]) => void) | ((...args: any[]) => any)
export type Event<T extends APIEndpoint>   = Brand<T>
export type Stream<T extends APIEndpoint>  = Brand<T>
export type Service<T extends APIEndpoint> = Brand<T>

/*  type utilities for generic API  */
export type APISchema = Record<string, APIEndpoint>

/*  extract event keys where type is branded as Event  */
export type EventKeys<T> = string extends keyof T ? string : {
    [ K in keyof T ]: T[K] extends Event<infer _F> ? K : never
}[ keyof T ]

/*  extract stream keys where type is branded as Stream  */
export type StreamKeys<T> = string extends keyof T ? string : {
    [ K in keyof T ]: T[K] extends Stream<infer _F> ? K : never
}[ keyof T ]

/*  extract service keys where type is branded as Service  */
export type ServiceKeys<T> = string extends keyof T ? string : {
    [ K in keyof T ]: T[K] extends Service<infer _F> ? K : never
}[ keyof T ]

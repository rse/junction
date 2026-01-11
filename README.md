
<img src="https://raw.githubusercontent.com/rse/mqtt-plus/master/etc/logo.svg" width="400" align="right" alt=""/>

MQTT+
=====

[MQTT](http://mqtt.org/) Communication Patterns

<p/>
<img src="https://nodei.co/npm/mqtt-plus.png?downloads=true&stars=true" alt=""/>

[![github (author stars)](https://img.shields.io/github/stars/rse?logo=github&label=author%20stars&color=%233377aa)](https://github.com/rse)
[![github (author followers)](https://img.shields.io/github/followers/rse?label=author%20followers&logo=github&color=%234477aa)](https://github.com/rse)

Installation
------------

```shell
$ npm install mqtt mqtt-plus
```

About
-----

This is **MQTT+**, an companion addon API for the excellent
[MQTT](http://mqtt.org/) client TypeScript/JavaScript API
[MQTT.js](https://www.npmjs.com/package/mqtt), provoding additional
communication patterns with optional type safety:

- **Event Emission**:

  Event Emission is a *uni-directional* communication pattern.
  An Event is the combination of an event name and optionally zero or more arguments.
  You *subscribe* to events.
  When an event is *emitted*, either a single particular subscriber (in case of
  a directed event emission) or all subscribers are called and receive the
  arguments as extra information.

  In contrast to the regular MQTT message publish/subscribe, this
  pattern allows to direct the event to particular subscribers and
  provides optional information about the sender to subscribers.

- **Stream Transfer**:

  Stream Transfer is a *uni-directional* communication pattern.
  A stream is the combination of a stream name, a `Readable` stream object and optionally zero or more arguments.
  You *attach* to a stream.
  When a stream is *transferred*, either a single particular attacher (in case of
  a directed stream transfer) or all attachers are called and receive the
  arguments as extra information. The `Readable` stream is available via
  `info.stream` in the attacher callback.

  In contrast to the regular MQTT message publish/subscribe, this
  pattern allows to transfer arbitrary amounts of arbitrary data by
  chunking the data via a stream.

- **Service Call**:

  Service Call is a *bi-directional* communication pattern.
  A Service is the combination of a service name and optionally zero or more arguments.
  You *register* for a service.
  When a service is *called*, a single particular registrator (in case
  of a directed service call) or one arbitrary registrator is called and
  receives the arguments as the request. The registrator then has to
  provide the service response.

  In contrast to the regular uni-directional MQTT message
  publish/subscribe communication, this allows a bi-directional [Remote
  Procedure Call](https://en.wikipedia.org/wiki/Remote_procedure_call)
  (RPC) style communication.

- **Resource Transfer**:

  Resource Transfer is a *bi-directional* communication pattern.
  A Resource is the combination of a resource name and optionally zero or more arguments.
  You *provision* for a resource transfer.
  When a resource is *fetched* or *pushed*, a single particular provisioner (in case
  of a directed resource transfer) or one arbitrary provisioner is called and
  sends or receives the resource and its arguments.

> [!Note]
> **MQTT+** is similar to and derived from
> [MQTT-JSON-RPC](https://github.com/rse/mqtt-json-rpc) of the same
> author, but instead of just JSON, MQTT+ encodes packets as JSON
> or CBOR (default), uses an own packet format (allowing sender and
> receiver information), uses shorter NanoIDs instead of longer UUIDs
> for identification of sender, receiver and requests, and has
> no support for stream transfers.

Usage
-----

### API:

The API type defines the available endpoints. Use the marker types
`Event<T>`, `Stream<T>`, and `Service<T>` to declare the communication
pattern of each endpoint:

```ts
import type * as MQTTpt from "mqtt-plus"

export type API = {
    "example/sample": MQTTpt.Event<(a1: string, a2: boolean) => void>    /*  event   */
    "example/upload": MQTTpt.Stream<(a1: string, a2: number) => void>    /*  stream  */
    "example/hello":  MQTTpt.Service<(a1: string, a2: number) => string> /*  service */
}
```

The marker types ensure that `subscribe()` and `emit()` only accept
`Event<T>` endpoints, `attach()` and `transfer()` only accept
`Stream<T>` endpoints, and `register()` and `call()` only accept
`Service<T>` endpoints.

### Server:

```ts
import MQTT         from "mqtt"
import MQTTp        from "mqtt-plus"
import type { API } from [...]

const mqtt  = MQTT.connect("wss://127.0.0.1:8883", { ... })
const mqttp = new MQTTp<API>(mqtt)

mqtt.on("connect", async () => {
    mqttp.subscribe("example/sample", (a1, a2) => {
        console.log("example/sample: ", a1, a2)
    })
    mqttp.register("example/hello", (a1, a2) => {
        console.log("example/hello: ", a1, a2)
        return `${a1}:${a2}`
    })
})
```

### Client:

```ts
import MQTT         from "mqtt"
import MQTTp        from "mqtt-plus"
import type { API } from [...]

const mqtt = MQTT.connect("wss://127.0.0.1:8883", { ... })
const mqttp = new MQTTp<API>(mqtt)

mqtt.on("connect", () => {
    mqttp.emit("example/sample", "foo", true)
    mqttp.call("example/hello", "world", 42).then((response) => {
        console.log("example/hello response: ", response)
        mqtt.end()
    })
})
```

Application Programming Interface
---------------------------------

The **MQTT+** API provides the following methods:

- **Construction**:<br/>

      constructor<API>(
          mqtt: MqttClient,
          options?: {
              id:         string
              codec:      "cbor" | "json"
              timeout:    number
              chunkSize:  number
              topicMake:  (name: string, operation: string, peerId?: string) => string
              topicMatch: (topic: string) => { name: string, operation: string, peerId?: string } | null
          }
      )

  The `API` is an optional TypeScript type `Record<string, ((...args:
  any[]) => void) | ((...args: any[]) => any)>`, describing the
  available events and services. Callbacks without return values
  describe events, callbacks with return values describe services.

  The `mqtt` is the [MQTT.js](https://www.npmjs.com/package/mqtt) instance,
  which has to be established separately.

  The optional `options` object supports the following fields:
  - `id`: Custom MQTT peer identifier (default: auto-generated NanoID).
  - `codec`: Encoding format (default: `cbor`).
  - `timeout`: Communication timeout in milliseconds (default: `10000`).
  - `chunkSize`: Chunk size in bytes for stream transfers (default: `16384`).
  - `topicMake`: Custom topic generation function.
    The `operation` parameter is one of: `event-notice`, `stream-chunk`, `service-call`, `resource-transfer`.
    (default: `` (name, operation, peerId) => `${name}/${operation}` + (peerId ? `/${peerId}` : "/any") ``)
  - `topicMatch`: Custom topic matching function.
    Returns `{ name, operation, peerId? }` or `null` if no match. The `peerId` is `undefined` for broadcast topics (ending with `/any`).
    (default: `` (topic) => { const m = topic.match(/^(.+)\/([^/]+)\/([^/]+)$/); return m ? { name: m[1], operation: m[2], peerId: m[3] === "any" ? undefined : m[3] } : null } ``)

- **Event Subscription**:<br/>

      /*  (simplified TypeScript API method signature)  */
      subscribe(
          event:    string,
          options?: MQTT::IClientSubscribeOptions
          callback: (
              ...params: any[],
              info: { sender: string, receiver?: string }
          ) => void
      ): Promise<Subscription>

  Subscribe to an event.
  The `event` has to be a valid MQTT topic name.
  The optional `options` allows setting MQTT.js `subscribe()` options like `qos`.
  The `callback` is called with the `params` passed to a remote `emit()`.
  There is no return value of `callback`.

  Internally, on the MQTT broker, the topics generated by
  `topicMake(event, "event-notice")` (default: `${event}/event-notice/any` and
  `${event}/event-notice/${peerId}`) are subscribed. Returns a
  `Subscription` object with an `unsubscribe()` method.

- **Stream Attachment**:<br/>

      /*  (simplified TypeScript API method signature)  */
      attach(
          stream:   string,
          options?: MQTT::IClientSubscribeOptions
          callback: (
              ...params: any[],
              info: { sender: string, receiver?: string, stream: stream.Readable }
          ) => void
      ): Promise<Attachment>

  Attach to (observe) a stream.
  The `stream` has to be a valid MQTT topic name.
  The optional `options` allows setting MQTT.js `subscribe()` options like `qos`.
  The `callback` is called with the `params` passed to a remote `transfer()`.
  The `info.stream` provides a Node.js `Readable` stream for consuming the transferred data.
  There is no return value of `callback`.

  Internally, on the MQTT broker, the topics generated by
  `topicMake(stream, "stream-chunk")` (default: `${stream}/stream-chunk/any` and
  `${stream}/stream-chunk/${peerId}`) are subscribed. Returns an
  `Attachment` object with an `unattach()` method.

- **Service Registration**:<br/>

      /*  (simplified TypeScript API method signature)  */
      register(
          service:  string,
          options?: MQTT::IClientSubscribeOptions
          callback: (
              ...params: any[],
              info: { sender: string, receiver?: string }
          ) => any
      ): Promise<Registration>

  Register a service.
  The `service` has to be a valid MQTT topic name.
  The optional `options` allows setting MQTT.js `subscribe()` options like `qos`.
  The `callback` is called with the `params` passed to a remote `call()`.
  The return value of `callback` will resolve the `Promise` returned by the remote `call()`.

  Internally, on the MQTT broker, the topics by
  `topicMake(service, "service-call")` (default: `${service}/service-call/any` and
  `${service}/service-call/${peerId}`) are subscribed. Returns a
  `Registration` object with an `unregister()` method.

- **Resource Provisioning**:<br/>

      /*  (simplified TypeScript API method signature)  */
      provision(
          resource: string,
          options?: MQTT::IClientSubscribeOptions
          callback: (
              ...params: any[],
              info: { sender: string, receiver?: string }
          ) => any
      ): Promise<Provisioning>

  Provision a resource.
  The `resource` has to be a valid MQTT topic name.
  The optional `options` allows setting MQTT.js `subscribe()` options like `qos`.
  The `callback` is called with the `params` passed to a remote `call()`.
  The return value of `callback` will resolve the `Promise` returned by the remote `fetch()` call.

  Internally, on the MQTT broker, the topics by
  `topicMake(resource, "resource-transfer")` (default: `${resource}/resource-transfer/any` and
  `${resource}/resource-transfer/${peerId}`) are subscribed. Returns a
  `Provisioning` object with an `unprovision()` method.

- **Event Emission**:<br/>

      /*  (simplified TypeScript API method signature)  */
      emit(
          event:     string,
          receiver?: Receiver,
          options?:  MQTT::IClientSubscribeOptions,
          ...params: any[]
      ): void

  Emit an event to all subscribers or a specific subscriber ("fire and forget").
  The optional `receiver` directs the event to a specific subscriber only.
  The optional `options` allows setting MQTT.js `publish()` options like `qos` or `retain`.

  The remote `subscribe()` `callback` is called with `params` and its
  return value is silently ignored.

  Internally, publishes to the MQTT topic by `topicMake(event, "event-notice", peerId)`
  (default: `${event}/event-notice/any` or `${event}/event-notice/${peerId}`).

- **Stream Transfer**:<br/>

      /*  (simplified TypeScript API method signature)  */
      transfer(
          stream:    string,
          readable:  stream.Readable,
          receiver?: Receiver,
          options?:  MQTT::IClientPublishOptions,
          ...params: any[]
      ): Promise<void>

  Transfer a stream to all attachers or a specific attacher.
  The `readable` is a Node.js `Readable` stream providing the data to transfer.
  The optional `receiver` directs the transfer to a specific attacher only.
  The optional `options` allows setting MQTT.js `publish()` options like `qos` or `retain`.

  The data is read from `readable` in chunks (default: 16KB,
  configurable via `chunkSize` option) and sent over MQTT until the
  stream is closed. The returned `Promise` resolves when the entire
  stream has been transferred.

  The remote `attach()` `callback` is called with `params` and an `info` object
  containing a `stream.Readable` for consuming the transferred data.

  Internally, publishes to the MQTT topic by `topicMake(stream, "stream-chunk", peerId)`
  (default: `${stream}/stream-chunk/any` or `${stream}/stream-chunk/${peerId}`).

- **Service Call**:<br/>

      /*  (simplified TypeScript API method signature)  */
      call(
          service:   string,
          receiver?: Receiver,
          options?:  MQTT::IClientSubscribeOptions,
          ...params: any[]
      ): Promise<any>

  Call a service on all registrants or on a specific registrant ("request and response").
  The optional `receiver` directs the call to a specific registrant only.
  The optional `options` allows setting MQTT.js `publish()` options like `qos` or `retain`.

  The remote `register()` `callback` is called with `params` and its
  return value resolves the returned `Promise`. If the remote `callback`
  throws an exception, this rejects the returned `Promise`.

  Internally, on the MQTT broker, the topic by `topicMake(service, "service-call", peerId)`
  (default: `${service}/service-call/${peerId}`) is temporarily subscribed
  for receiving the response.

- **Resource Transfer**:<br/>

      /*  (simplified TypeScript API method signature)  */
      fetch(
          blob:      string,
          receiver?: Receiver,
          options?:  MQTT::IClientSubscribeOptions,
          ...params: any[]
      ): Promise<Buffer>

  Fetches a resource from any resource provisioner or from a specific provisioner.
  The optional `receiver` directs the call to a specific provisioner only.
  The optional `options` allows setting MQTT.js `publish()` options like `qos` or `retain`.

  The remote `provision()` `callback` is called with `params` and its
  return value resolves the returned `Promise`. If the remote `callback`
  throws an exception, this rejects the returned `Promise`.

  Internally, on the MQTT broker, the topic by
  `topicMake(resource, "resource-transfer", peerId)` (default:
  `${resource}/resource-transfer/${peerId}`) is temporarily subscribed
  for receiving the response.

- **Receiver Wrapping**:<br/>

      receiver(
          id: string
      ): Receiver

  Wrap a receiver ID string for use with `emit()` or `call()` to direct the
  message to a specific receiver. Returns a `Receiver` object.

Internals
---------

In the following, we assume that an **MQTT+** instance is created with:

```ts
import MQTT  from "mqtt"
import MQTTp from "mqtt-plus"

const mqtt  = MQTT.connect("...", { ... })
const mqttp = new MQTTp(mqtt, { codec: "json" })
```

Internally, remote services are assigned to MQTT topics. When calling a
remote service named `example/hello` with parameters `"world"` and `42` via...

```ts
mqttp.call("example/hello", "world", 42).then((result) => {
    ...
})
```

...the following message is sent to the permanent MQTT topic
`example/hello/service-call/any` (the shown NanoIDs are just pseudo
ones):

```json
{
    "id":      "vwLzfQDu2uEeOdOfIlT42",
    "sender":  "2IBMSk0NPnrz1AeTERoea",
    "method":  "example/hello",
    "params":  [ "world", 42 ]
}
```

Beforehand, this `example/hello` service should have been registered with...

```ts
mqttp.register("example/hello", (a1, a2) => {
    return `${a1}:${a2}`
})
```

...and then its result, in the above `mqttp.call()` example `"world:42"`, is then
sent back as the following success response
message to the temporary (client-specific) MQTT topic
`example/hello/service-call/2IBMSk0NPnrz1AeTERoea`:

```json
{
    "id":      "vwLzfQDu2uEeOdOfIlT42",
    "sender":  "2IBMSk0NPnrz1AeTERoea",
    "result":  "world:42"
}
```

The `sender` field is the NanoID of the MQTT+ sender instance and
`id` is the NanoID of the particular service request. The `sender` is
used for sending back the response message to the requestor only. The
`id` is used for correlating the response to the request only.

Broker Setup
------------

For a real test-drive of MQTT+, install the
[Mosquitto](https://mosquitto.org/) MQTT broker and a `mosquitto.conf`
file like...

```
[...]

password_file        mosquitto-pwd.txt
acl_file             mosquitto-acl.txt

[...]

#   additional listener
listener             1883 127.0.0.1
max_connections      -1
protocol             mqtt

[...]
```

...and an access control list in `mosquitto-acl.txt` like...

```
#   shared ACL
topic   read      $SYS/#
pattern write     $SYS/broker/connection/%c/state
pattern readwrite %u/#

#   anonymous ACL
topic   read      event/+
pattern read      event/+/%c
topic   write     event/+/+
pattern read      service/+/%c
topic   write     service/+
topic   write     service/+/+

#   user ACL
user    example
topic   read      event/+
pattern read      event/+/%c
topic   write     event/+
topic   write     event/+/+
topic   read      service/+
pattern read      service/+/%c
topic   write     service/+
topic   write     service/+/+
```

...and an `example` user (with password `example`) in `mosquitto-pwd.txt` like:

```
example:$6$awYNe6oCAi+xlvo5$mWIUqyy4I0O3nJ99lP1mkRVqsDGymF8en5NChQQxf7KrVJLUp1SzrrVDe94wWWJa3JGIbOXD9wfFGZdi948e6A==
```

Alternatively, you can use the [NPM package mosquitto](https://npmjs.com/mosquitto)
for an equal setup.

Example
-------

You can test-drive MQTT+ with a complete [sample](sample/sample.ts) to see
it in action and tracing its communication (the typing of the `MQTTp`
class with `API` is optional, but strongly suggested):

```ts
import Mosquitto        from "mosquitto"
import MQTT             from "mqtt"
import MQTTp            from "mqtt-plus"
import type * as MQTTpt from "mqtt-plus"

const mosquitto = new Mosquitto()
await mosquitto.start()
await new Promise((resolve) => { setTimeout(resolve, 500) })

const mqtt = MQTT.connect("mqtt://127.0.0.1:1883", {
    username: "example",
    password: "example"
})

type API = {
    "example/sample": MQTTpt.Event<(a1: string, a2: number) => void>
    "example/hello":  MQTTpt.Service<(a1: string, a2: number) => string>
}

const mqttp = new MQTTp<API>(mqtt, { codec: "json" })

type Sample = (a: string, b: number) => string

mqtt.on("error",     (err)            => { console.log("ERROR", err) })
mqtt.on("offline",   ()               => { console.log("OFFLINE") })
mqtt.on("close",     ()               => { console.log("CLOSE") })
mqtt.on("reconnect", ()               => { console.log("RECONNECT") })
mqtt.on("message",   (topic, message) => { console.log("RECEIVED", topic, message.toString()) })

mqtt.on("connect", () => {
    console.log("CONNECT")
    mqttp.register("example/hello", (a1, a2) => {
        console.log("example/hello: request: ", a1, a2)
        return `${a1}:${a2}`
    })
    mqttp.call("example/hello", "world", 42).then((result) => {
        console.log("example/hello success: ", result)
        mqtt.end()
        await mosquitto.stop()
    }).catch((err) => {
        console.log("example/hello error: ", err)
    })
})
```

The output will be:

```
$ node sample.ts
CONNECT
RECEIVED example/hello/service-call/any {"id":"vwLzfQDu2uEeOdOfIlT42","sender":"2IBMSk0NPnrz1AeTERoea","service":"example/hello","params":["world",42]}
example/hello: request:  world 42 undefined
RECEIVED example/hello/service-call/2IBMSk0NPnrz1AeTERoea {"id":"vwLzfQDu2uEeOdOfIlT42","sender":"2IBMSk0NPnrz1AeTERoea","receiver":"2IBMSk0NPnrz1AeTERoea","result":"world:42"}
example/hello success:  world:42
CLOSE
```

License
-------

Copyright (c) 2018-2025 Dr. Ralf S. Engelschall (http://engelschall.com/)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


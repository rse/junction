
import Mosquitto from "mosquitto"
import MQTT      from "mqtt"
import MQTTp     from "mqtt-plus"

const mosquitto = new Mosquitto({
    listen: [ { protocol: "wss", address: "127.0.0.1", port: 8443 } ]
})
await mosquitto.start()
await new Promise((resolve) => { setTimeout(resolve, 500) })

const mqtt = MQTT.connect("wss://127.0.0.1:8443", {
    rejectUnauthorized: false,
    username: "example",
    password: "example"
})

type API = {
    "example/sample": (a1: string, a2: number) => void
    "example/hello":  (a1: string, a2: number) => string
}

const mqttp = new MQTTp<API>(mqtt, { codec: "json" })

mqtt.on("error",     (err)            => { console.log("ERROR", err) })
mqtt.on("offline",   ()               => { console.log("OFFLINE") })
mqtt.on("close",     ()               => { console.log("CLOSE") })
mqtt.on("reconnect", ()               => { console.log("RECONNECT") })
mqtt.on("message",   (topic, message) => { console.log("RECEIVED", topic, message.toString()) })

mqtt.on("connect", () => {
    console.log("CONNECT")
    mqttp.subscribe("example/sample", (a1, a2, info) => {
        console.log("example/sample: info: ", a1, a2, info.sender)
    })
    mqttp.emit("example/sample", "world", 42)
    mqttp.register("example/hello", (a1, a2, info) => {
        console.log("example/hello: request: ", a1, a2, info.sender)
        return `${a1}:${a2}`
    })
    mqttp.call("example/hello", "world", 42).then(async (result) => {
        console.log("example/hello success: ", result)
        mqtt.end()
        await mosquitto.stop()
    }).catch((err) => {
        console.log("example/hello error: ", err)
    })
})


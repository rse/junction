
import MQTT         from "mqtt"
import Junction     from "junction"
import type { API } from "./sample-common"

const mqtt = MQTT.connect("ws://127.0.0.1:8443", {
    rejectUnauthorized: false,
    username: "example",
    password: "example"
})

const junction = new Junction<API>(mqtt, { codec: "json" })

mqtt.on("error",     (err)            => { console.log("ERROR", err) })
mqtt.on("offline",   ()               => { console.log("OFFLINE") })
mqtt.on("close",     ()               => { console.log("CLOSE") })
mqtt.on("reconnect", ()               => { console.log("RECONNECT") })
mqtt.on("message",   (topic, message) => { console.log("RECEIVED", topic, message.toString()) })

mqtt.on("connect", () => {
    console.log("CONNECT")
    junction.emit("example/sample", "world", 42)
    junction.call("example/hello", "world", 42).then((result) => {
        console.log("example/hello success: ", result)
    }).catch((err) => {
        console.log("example/hello error: ", err)
    })
})


/*
**  Junction -- HTTP/REST over MQTT Gateway
**  Copyright (c) 2025-2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
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

/*  external dependencies  */
import pino                       from "pino"

/*  the logging level shared by all Junction services  */
export type LogLevel = "debug" | "info" | "warn" | "error"

/*  a single structured log record handed to a caller-supplied log sink  */
export type LogRecord = {
    level: LogLevel               /*  log level ("debug"|"info"|"warn"|"error")  */
    time:  string                 /*  ISO-8601 timestamp (UTC)  */
    msg:   string                 /*  the log message text  */
}

/*  a caller-supplied callback receiving each structured log record;
    when provided, it fully replaces the built-in pino-pretty console output  */
export type LogSink = (record: LogRecord) => void

/*  the minimal logging facility surface used by all Junction services
    (a subset of pino's "Logger", so a real pino instance satisfies it too)  */
export type JunctionLogger = {
    debug:          (msg: string) => void
    info:           (msg: string) => void
    warn:           (msg: string) => void
    error:          (msg: string) => void
    isLevelEnabled: (level: LogLevel) => boolean
}

/*  numeric severity order of the logging levels (ascending)  */
const levelOrder: Record<LogLevel, number> = { debug: 1, info: 2, warn: 3, error: 4 }

/*  establish a logging facility shared by all Junction services:
    by default it pretty-prints to the console via "pino-pretty"; when a
    "logSink" callback is supplied, pino is bypassed entirely and each
    structured record is handed directly to the callback instead, so an
    outer application can re-log it through its own logging facility  */
export function makeLogger (logLevel: LogLevel, logSink?: LogSink): JunctionLogger {
    /*  case 1: caller captures structured records via a sink callback;
        build the records directly without involving pino or any serialization  */
    if (logSink !== undefined) {
        const threshold = levelOrder[logLevel]
        const isLevelEnabled = (level: LogLevel) => levelOrder[level] >= threshold
        const emit = (level: LogLevel, msg: string) => {
            if (isLevelEnabled(level))
                logSink({ level, time: new Date().toISOString(), msg })
        }
        return {
            debug: (msg: string) => emit("debug", msg),
            info:  (msg: string) => emit("info",  msg),
            warn:  (msg: string) => emit("warn",  msg),
            error: (msg: string) => emit("error", msg),
            isLevelEnabled
        }
    }

    /*  case 2: default pretty-printed console output via "pino-pretty"  */
    return pino({
        level: logLevel,
        formatters: {
            level: (label) => ({ level: label.toUpperCase() })
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        transport: {
            target: "pino-pretty",
            options: {
                colorize:      process.stdout.isTTY,
                customColors:  "info:blue,warn:yellow,error:red,message:reset",
                translateTime: "UTC:yyyy-mm-dd HH:MM:ss.l",
                ignore:        "pid,hostname"
            }
        }
    })
}

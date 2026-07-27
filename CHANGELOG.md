
ChangeLog
=========

0.9.10 (2026-07-27)
-------------------

- FEATURE: acquire and renew Let's Encrypt certificates in the orchestrator via @certd/acme-client
- FEATURE: add optional proxy.tls.staging option to order against the Let's Encrypt staging directory

0.9.9 (2026-07-13)
------------------

- FEATURE: add backend "share" option and CLI -s for MQTT5 shared-subscription load-balancing
- IMPROVEMENT: use linux/arm64 for QUICK Docker builds on en4 host
- BUGFIX: skip proxy backend SSL verification in HAProxy router to avoid cert problems

0.9.8 (2026-06-22)
------------------

- FEATURE: add shared logger module with a `logSink` option to capture structured log records across all services

0.9.7 (2026-06-22)
------------------

- BUGFIX: increase HAProxy tunnel and tune MQTT keepalive/reconnect timeouts to circumvent connection problems

0.9.6 (2026-06-18)
------------------

- IMPROVEMENT: support QUICK single-platform Docker builds in stx config
- UPDATE: bump base versions and pin sub-images to "latest" in junction.dockerfile

0.9.5 (2026-06-10)
------------------

- IMPROVEMENT: accept a pre-connected MQTT client and move the broker URL into the options

0.9.4 (2026-06-10)
------------------

- BUGFIX: change the API re-export strategy

0.9.3 (2026-06-10)
------------------

- FEATURE: add nftables router type as alternative to HAProxy in orchestrator
- FEATURE: add backend "watch" option and CLI --no-watch to disable filesystem watching
- IMPROVEMENT: publish packages to the GitHub container registry
- CLEANUP: add back trailing blank lines in source files

0.9.2 (2026-06-08)
------------------

- FEATURE: add option -e/--env-file to load a particular .env file
- IMPROVEMENT: improve MQTT/broker/HAProxy logging and connection observability
- IMPROVEMENT: distinguish URL path (WebSocket connect) from MQTT topic (communication)
- IMPROVEMENT: give MQTT client an explicit client id (reused by MQTT+ too)
- IMPROVEMENT: improve startup ordering by avoiding retries
- BUGFIX: fix cache hits/misses for index files ("/" vs "index.html")
- BUGFIX: fix MQTT bridge transfer and replace broken broker ACLs with MQTT+ ones
- UPDATE: update NPM dependencies and add nanoid
- CLEANUP: remove debugging aid and keep debugging scripts in stx config

0.9.1 (2026-06-08)
------------------

- UPGRADE: upgrade NPM dependencies

0.9.0 (2026-06-08)
------------------

(first rough cut of library)


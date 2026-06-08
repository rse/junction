#!/bin/bash
##
##  junction.rc.bash -- Docker Image Run-Command Script
##

cd /app/etc || exit $?

export JUNCTION_RUN_UID=app
export JUNCTION_RUN_GID=app

exec node \
    /app/lib/junction/dst/junction-cli.js \
        orchestrator \
            -d /app/var/junction \
            -p \
            ${1+"$@"}


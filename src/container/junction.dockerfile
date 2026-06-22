##
##  junction.dockerfile -- Docker Build Configuration
##

#   build arguments (early)
ARG         IMAGE_PREFIX=ghcr.io/rse/
ARG         IMAGE_NAME=junction
ARG         IMAGE_VERSION=0.9.8
ARG         IMAGE_RELEASE=20260622
ARG         IMAGE_ALIAS=latest

#   derive image from a certain base image
FROM        node:26.2-trixie

#   prepare Debian
RUN         apt-get update && \
            apt-get upgrade -y

#   extend Debian
RUN         apt-get install -y --no-install-recommends bash curl gosu nftables && \
            apt-get install -y --no-install-recommends libc6 libssl3 libc-ares2 libsqlite3-0 liblua5.4

#   establish application area and user/group
RUN         groupadd -g 2000 app
RUN         useradd -u 2000 -g app -d /app -m -s /bin/bash -p '!' -l app
RUN         mkdir -p -m 755 /app

#   establish application area
RUN         mkdir -p -m 755 /app/bin /app/etc /app/libexec /app/var /app/share

#   install HAProxy
COPY        --from=ghcr.io/rse/junction-haproxy:latest /app/bin/haproxy      /app/bin/
RUN         chmod 755 /app/bin/haproxy

#   install Mosquitto
COPY        --from=ghcr.io/rse/junction-mosquitto:latest /app/bin/mosquitto* /app/bin/
COPY        --from=ghcr.io/rse/junction-mosquitto:latest /app/libexec/*      /app/libexec/
RUN         chmod 755 /app/bin/mosquitto*

#   strip down binaries
RUN         apt-get install -y --no-install-recommends binutils
RUN         strip /app/bin/*
RUN         apt-get purge -y binutils && \
            apt-get autoremove -y

#   install Junction
RUN         mkdir -p /app/lib/junction
RUN         mkdir -p /app/var/junction
WORKDIR     /app/lib/junction
COPY        junction.tar .
COPY        junction.rc.bash /app/bin/junction
RUN         chmod 755 /app/bin/junction
RUN         tar xf junction.tar
RUN         npm install --legacy-peer-deps
RUN         npm start build

#   extend environment
ENV         PATH=/app/bin:$PATH

#   cleanup Debian
RUN         apt-get clean && \
            rm -rf /var/lib/apt/lists/*

#   fixate ownerships
RUN         chown -R app:app /app

#   provide volume
VOLUME      [ "/app/var" ]

#   provide entrypoint
ENTRYPOINT  [ "/app/bin/junction" ]
CMD         [ "" ]

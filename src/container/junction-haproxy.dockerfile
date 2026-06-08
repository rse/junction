##
##  Dockerfile -- Docker Build Configuration
##

#   build arguments (early)
ARG         IMAGE_PREFIX=ghcr.io/rse/
ARG         IMAGE_NAME=junction-haproxy
ARG         IMAGE_VERSION=0.9.0
ARG         IMAGE_RELEASE=20260527
ARG         IMAGE_ALIAS=latest

#   derive image from a certain base image
FROM        debian:trixie AS stage1

#   add additional build tools
RUN         apt update && \
            apt upgrade -y && \
            apt install -y curl binutils binutils-gold gcc g++ cmake make xsltproc git patch && \
            apt install -y libc6-dev libssl-dev libc-ares-dev uthash-dev zlib1g-dev linux-libc-dev sqlite3 libsqlite3-dev libpcre2-dev liblua5.4-dev

#   create build environment
WORKDIR     /tmp/build

#   build HAProxy
ENV         VERSION_HAPROXY_MAJOR=3.3
ENV         VERSION_HAPROXY_MINOR=10
ENV         VERSION_HAPROXY=${VERSION_HAPROXY_MAJOR}.${VERSION_HAPROXY_MINOR}
RUN         curl -s -k -L \
                http://www.haproxy.org/download/${VERSION_HAPROXY_MAJOR}/src/haproxy-${VERSION_HAPROXY}.tar.gz | \
                tar zxf -
RUN         (   cd haproxy-${VERSION_HAPROXY} && \
                make -j "$(nproc)" \
                    TARGET=linux-glibc \
                    USE_OPENSSL=1 \
                    SSL_INC=/usr/include \
                    SSL_LIB=/usr/lib \
                    USE_ZLIB=1 \
                    ZLIB_INC=/usr/include \
                    ZLIB_LIB=/usr/lib \
                    USE_LUA=1 \
                    LUA_INC=/usr/include/lua5.4 \
                    LUA_LIB=/usr/lib/lua5.4 \
                    USE_PCRE=0 \
                    USE_PCRE2=1 \
                    PCRE2_INC=/usr/include \
                    PCRE2_LIB=/usr/lib \
                    USE_STATIC_PCRE2=1 \
                    USE_PROMEX=1 \
                    USE_BACKTRACE="" && \
                strip haproxy && \
                mkdir -p /app/bin && \
                mv haproxy /app/bin/ \
            )

#   cleanup Debian
RUN         apt clean && \
            rm -rf /var/lib/apt/lists/*

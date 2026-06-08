##
##  Dockerfile -- Docker Build Configuration
##

#   build arguments (early)
ARG         IMAGE_PREFIX=ghcr.io/rse/
ARG         IMAGE_NAME=junction-mosquitto
ARG         IMAGE_VERSION=0.9.0
ARG         IMAGE_RELEASE=20260527
ARG         IMAGE_ALIAS=latest

#   derive image from a certain base image
FROM        golang:1.26.3-trixie

#   add additional build tools
RUN         apt-get update && \
            apt-get upgrade -y && \
            apt-get install -y curl binutils binutils-gold gcc g++ cmake make xsltproc git patch && \
            apt-get install -y libc6-dev libssl-dev libc-ares-dev uthash-dev zlib1g-dev linux-libc-dev sqlite3 libsqlite3-dev libpcre2-dev liblua5.4-dev

#   create build environment
WORKDIR     /tmp/build

#   build cJSON
ENV         VERSION_CJSON=1.7.19
RUN         curl -sSkL https://github.com/DaveGamble/cJSON/archive/refs/tags/v${VERSION_CJSON}.tar.gz | \
                tar zxf -
RUN         cd cJSON-${VERSION_CJSON} && \
            cmake \
                -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
                -DCMAKE_BUILD_TYPE="Release" \
                -DCMAKE_INSTALL_PREFIX="/app" \
                -DCMAKE_C_FLAGS="-Wno-deprecated-declarations" \
                -DBUILD_SHARED_LIBS=OFF \
                -DENABLE_CJSON_TEST=OFF \
                . && \
            make && \
            make install

#   build libwebsockets
ENV         VERSION_LIBWEBSOCKETS=4.5.8
RUN         curl -sSkL https://github.com/warmcat/libwebsockets/archive/v${VERSION_LIBWEBSOCKETS}.tar.gz | \
                tar zxf -
RUN         cd libwebsockets-${VERSION_LIBWEBSOCKETS} && \
            cmake \
                -DCMAKE_BUILD_TYPE="Release" \
                -DCMAKE_INSTALL_PREFIX="/app" \
                -DCMAKE_C_FLAGS="-Wno-deprecated-declarations" \
                -DBUILD_SHARED_LIBS=OFF \
                -DLWS_IPV6=ON \
                -DLWS_WITHOUT_BUILTIN_GETIFADDRS=ON \
                -DLWS_WITH_SHARED=OFF \
                -DLWS_WITH_STATIC=ON \
                -DLWS_WITH_SSL=ON \
                -DLWS_WITH_ZLIB=ON \
                -DLWS_WITH_HTTP2=ON \
                -DLWS_WITH_LIBEV=OFF \
                -DLWS_WITH_LIBUV=OFF \
                -DLWS_WITH_EXTERNAL_POLL=ON \
                -DLWS_WITHOUT_CLIENT=ON \
                -DLWS_WITHOUT_TESTAPPS=ON \
                -DLWS_WITHOUT_EXTENSIONS=OFF \
                -DDISABLE_WERROR=ON \
                . && \
            make && \
            make install

#   build Mosquitto
ENV         VERSION_MOSQUITTO=2.1.2
RUN         curl -sSkL https://mosquitto.org/files/source/mosquitto-${VERSION_MOSQUITTO}.tar.gz | \
                tar zxf -
COPY        junction-mosquitto.patch .
RUN         cd mosquitto-${VERSION_MOSQUITTO} && \
            patch -p0 <../junction-mosquitto.patch && \
            cmake \
                -DCMAKE_BUILD_TYPE="Release" \
                -DCMAKE_INSTALL_PREFIX="/app" \
                -DCMAKE_C_FLAGS="-Wno-deprecated-declarations -I/app/include -I`pwd`/libcommon -I`pwd`/deps/picohttpparser" \
                -DCMAKE_CXX_FLAGS="-Wno-deprecated-declarations -I/app/include -I`pwd`/libcommon -I`pwd`/deps/picohttpparser" \
                -DCMAKE_EXE_LINKER_FLAGS="-L/app/lib" \
                -DBUILD_SHARED_LIBS=OFF \
                -DWITH_STATIC_LIBRARIES=ON \
                -DSTATIC_WEBSOCKETS=ON \
                -DWITH_TESTS=OFF \
                -DWITH_PIC=ON \
                -DWITH_ADNS=OFF \
                -DWITH_WEBSOCKETS=ON \
                -DWITH_PLUGINS=ON \
                -DWITH_TLS=ON \
                -DWITH_TLS_PSK=ON \
                -DWITH_SRV=ON \
                . && \
            make && \
            make install && \
            mkdir -p /app/libexec && \
            cp -p plugins/*/mosquitto_*.so /app/libexec/ && \
            rm -rf /app/lib && \
            mv /app/sbin/mosquitto /app/bin/mosquitto

#   build Mosquitto authentication plugin
ENV         VERSION_PLUGIN=20ee931
RUN         git clone https://github.com/iegomez/mosquitto-go-auth && \
            cd mosquitto-go-auth && \
            git checkout -f "${VERSION_PLUGIN}"
RUN         cd mosquitto-go-auth && \
            env CGO_CFLAGS="-D_LARGEFILE64_SOURCE -fPIC -I`pwd`/../mosquitto-${VERSION_MOSQUITTO}/include -I/app/include" \
                CGO_LDFLAGS="-shared" \
                go build -v -buildmode=c-archive go-auth.go && \
            env CGO_CFLAGS="-D_LARGEFILE64_SOURCE -fPIC -I`pwd`/../mosquitto-${VERSION_MOSQUITTO}/include -I/app/include" \
                CGO_LDFLAGS="-shared" \
                go build -v -buildmode=c-shared -o go-auth.so && \
            env CGO_CFLAGS="-D_LARGEFILE64_SOURCE -fPIC -I`pwd`/../mosquitto-${VERSION_MOSQUITTO}/include -I/app/include" \
                CGO_LDFLAGS="" \
                go build -o pw pw-gen/pw.go && \
            mkdir -p /app/libexec && \
            cp -p go-auth.so /app/libexec/mosquitto-go-auth.so && \
            cp -p pw /app/bin/mosquitto_pw

#   cleanup Debian
RUN         apt-get clean && \
            rm -rf /var/lib/apt/lists/*

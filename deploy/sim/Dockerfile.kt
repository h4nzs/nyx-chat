# syntax=docker/dockerfile:1.7
# Empat binary KT v2 dibangun dari modul yang ter-vendor penuh (tanpa jaringan).
FROM golang:1.27-bookworm AS build

WORKDIR /src
COPY server/kt-query/go.mod server/kt-query/go.sum ./
COPY server/kt-query/vendor ./vendor
COPY server/kt-query ./
RUN CGO_ENABLED=0 go build -mod=vendor -trimpath -o /out/nyx-kt-query-v2 ./cmd/nyx-kt-query-v2 \
 && CGO_ENABLED=0 go build -mod=vendor -trimpath -o /out/nyx-kt-auditor-v2 ./cmd/nyx-kt-auditor-v2 \
 && CGO_ENABLED=0 go build -mod=vendor -trimpath -o /out/nyx-kt-v2-init ./cmd/nyx-kt-v2-init \
 && CGO_ENABLED=0 go build -mod=vendor -trimpath -o /out/nyx-kt-v2-check ./cmd/nyx-kt-v2-check

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/nyx-kt-query-v2 /usr/local/bin/
COPY --from=build /out/nyx-kt-auditor-v2 /usr/local/bin/
COPY --from=build /out/nyx-kt-v2-init /usr/local/bin/
COPY --from=build /out/nyx-kt-v2-check /usr/local/bin/

WORKDIR /kt
CMD ["nyx-kt-query-v2"]

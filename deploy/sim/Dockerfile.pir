# syntax=docker/dockerfile:1.7
FROM rust:1.95-bookworm AS build

WORKDIR /src
COPY server/pir-sidecar/Cargo.toml server/pir-sidecar/Cargo.lock ./
COPY server/pir-sidecar/src ./src
RUN cargo build --release --locked --bin pir-service

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/pir-service /usr/local/bin/pir-service

WORKDIR /shards
EXPOSE 9470 9471
CMD ["pir-service"]

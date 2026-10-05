FROM rust:1.98-bookworm AS wasm
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler clang && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-pack --locked
WORKDIR /src/wasm-crypto
COPY wasm-crypto/ .
RUN wasm-pack build --target web

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY --from=wasm /src/wasm-crypto/pkg wasm-crypto/pkg
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY web/ web/
ARG VITE_STUN_URL
# Set to 1 for a client that asks for its server at first launch (see README, "Using a copy of the app your instance did not serve").
ARG VITE_REQUIRE_SERVER_URL
RUN cd web && npm run build

# `docker build --target client-files --output <dir>` writes the static client out, no Rust or Node needed on the host.
FROM scratch AS client-files
COPY --from=web /src/web/dist /

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /src/web/dist /srv

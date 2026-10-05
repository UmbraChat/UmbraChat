FROM rust:1.98-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler clang && rm -rf /var/lib/apt/lists/*
WORKDIR /src/server
COPY server/ .
ENV SQLX_OFFLINE=true
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home umbrachat
COPY --from=build /src/server/target/release/umbrachat-server /usr/local/bin/umbrachat-server
USER umbrachat
EXPOSE 3000
CMD ["umbrachat-server"]

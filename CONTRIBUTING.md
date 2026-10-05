# Contributing to UmbraChat

## Layout

- `server/`: Rust (Axum, sqlx, PostgreSQL) API
- `wasm-crypto/`: Rust wrapper around the official `libsignal-protocol`, built to WebAssembly for the browser
- `web/`: React PWA (Vite)
- `deploy/`: Dockerfiles, Caddy and coturn configuration used by `compose.yaml`
- `aidd_docs/`: design history and project memory (`aidd_docs/INSTALL.md` is the original stack audit, not an install guide; to run the project see `README.md`)

## Development setup

Needs Rust (stable), `protoc`, `wasm-pack`, Node 22, and Docker for a throwaway PostgreSQL.

```sh
# database
docker run -d --rm --name umbra-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=umbra -p 5432:5432 postgres:16-alpine
export DATABASE_URL=postgres://postgres:pw@localhost:5432/umbra

# server (runs migrations on start; needs a VAPID private key, any value works unless you test push)
cd server && VAPID_PRIVATE_KEY=<key> cargo run

# web (build the wasm package first, once and after any wasm-crypto change)
cd wasm-crypto && wasm-pack build --target web
cd web && npm ci && npm run dev    # http://localhost:5173, /v1 is proxied to :3000
```

## Tests

- Server: `cd server && cargo test` (integration tests need `DATABASE_URL` and a migrated database: `cargo sqlx migrate run`). Run without `SQLX_OFFLINE`.
- Browser end-to-end: with the server and `npm run dev` running, `npx playwright install chromium-headless-shell` once, then `cd web && npm run e2e:<name>` (see `web/package.json`). The scripts expect the app at `http://localhost:5173`, which is also what the compose stack serves with `HTTP_PORT=5173`; `e2e-typing-signal.mjs` imports source modules and only works against `npm run dev`. The push test reads the database through `DB_EXEC` (default `podman exec -i umbrachat-postgres`; with the compose stack use `DB_EXEC="docker exec -i umbrachat-db-1"`, and `DB_USER`/`DB_NAME` if your database is not `umbrachat`). `e2e-smoketest.mjs` reads `DATABASE_URL`.
- Lint and types: `cd web && npm run lint && npm run build`.

## Changing SQL

Queries are checked at compile time. After changing a query or a migration, regenerate the offline cache the Docker build relies on and commit it:

```sh
cd server && cargo sqlx prepare
```

## Conventions

- Commits follow `<type>(<scope>): description` where practical.
- Add or extend tests alongside the code.
- A change an older or newer app or server could misread (API shape, envelope format) bumps `PROTOCOL_VERSION` in `server/src/protocol.rs` and `web/src/api/protocol.ts` together; `server/tests/protocol.rs` fails if they differ.
- The server stays zero-knowledge: check every route against that before it ships.
- The device-list statement layout and rules live in `web/src/crypto/deviceList.ts` and `server/src/device_list.rs`; change both together, with `PROTOCOL_VERSION` (a statement is signed as exact bytes, so a layout change breaks every existing chain).

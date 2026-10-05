import { readFileSync, existsSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// mkcert-generated dev cert (see .certs/), gitignored - WebCrypto is disabled
// by every browser on plain HTTP unless the origin is localhost, so testing
// on a real phone over the LAN needs real HTTPS. Gated behind VITE_HTTPS
// rather than always-on: localhost itself already counts as a secure context
// over plain HTTP, so e2e tests (which hardcode http://localhost:5173) and
// day-to-day dev keep working unmodified; only LAN/mobile testing opts in
// with `VITE_HTTPS=1 npm run dev -- --host`.
const useHttps = process.env.VITE_HTTPS === '1' && existsSync('.certs/cert.pem') && existsSync('.certs/key.pem')

// The Content-Security-Policy travels inside the build (a meta tag), so a copy served by any
// static file server has it, not only the one behind deploy/Caddyfile (which sets the same
// policy as a header, plus frame-ancestors, which a meta tag cannot carry). A build that
// asks for its server at runtime must be allowed to reach any https server, and localhost.
// Build only: the dev server needs inline scripts for hot reload.
const connectSrc = process.env.VITE_REQUIRE_SERVER_URL === '1' ? "'self' https: http://localhost:* http://127.0.0.1:*" : "'self'"
const csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src ${connectSrc}; worker-src 'self'; object-src 'none'; base-uri 'none'`

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'content-security-policy',
      apply: 'build',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
    },
  ],
  server: {
    fs: {
      // wasm-crypto is a sibling package (file: dependency, symlinked via
      // node_modules), so it resolves outside this project's root — Vite's
      // dev server blocks serving files outside it by default.
      allow: ['..'],
    },
    https: useHttps ? { cert: readFileSync('.certs/cert.pem'), key: readFileSync('.certs/key.pem') } : undefined,
    // Keeps the API same-origin from the browser's point of view so an HTTPS
    // page can call it without mixed-content blocking or CORS - Vite proxies
    // to the plain-HTTP Rust server itself, server-to-server. Left on
    // unconditionally since API_BASE defaults to same-origin either way.
    proxy: { '/v1': 'http://localhost:3000' },
  },
})

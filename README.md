# UmbraChat

End-to-end encrypted messenger you host yourself. The server only stores and relays encrypted envelopes and public keys; it never holds anything that can decrypt a message.

**This project runs no public instance and offers no hosted service.** You run your own, for yourself or the people you choose. Instances are independent: an account on one cannot message an account on another (no federation, by design: it would expose who talks to whom between servers).

## Who you trust

Whoever runs your instance, the way you trust the administrator of a mail server. They cannot read your messages, files or calls, but they can see who has an account and who writes to whom and when, and, because they also serve the web app, one who is malicious could serve a modified app that leaks your keys. Pick an instance run by someone you trust, or run your own.

## What works today

Web client (PWA) and Rust server, with the Signal protocol (PQXDH + Double Ratchet, official `libsignal` compiled to WebAssembly for the browser):

- 1:1 text messages, file sharing, disappearing messages, self-destructing files
- Groups
- Voice and video calls (WebRTC, optional relay for hard networks)
- Several linked devices per account (each account's device list is signed by its own devices, so the server cannot add or hide one), encrypted local storage, encrypted backup export and restore
- Web Push notifications, nicknames, typing indicator, screenshot detection

No native iOS or Android apps yet.

## Run your own instance

You need a machine with Docker (Compose v2), and for a real deployment a domain name pointing at it with ports 80 and 443 open. HTTPS is mandatory: the browser disables the crypto APIs the client needs on plain HTTP (except on `localhost`).

```sh
git clone https://github.com/UmbraChat/UmbraChat.git
cd UmbraChat
cp .env.example .env
```

Fill in `.env`:

```sh
openssl rand -hex 24                 # POSTGRES_PASSWORD
npx web-push generate-vapid-keys     # VAPID_PRIVATE_KEY (keep the private key; the server serves the public one)
```

Set `SITE_ADDRESS` to your domain (Caddy gets the TLS certificate itself), or keep `http://localhost` for a trial on your own machine, then:

```sh
docker compose up -d --build
```

The first build compiles Rust and WebAssembly and takes several minutes. Open `SITE_ADDRESS` in a browser (`http://localhost` for the trial). Database migrations run on server start.

### Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SITE_ADDRESS` | no (`http://localhost`) | Domain served by Caddy, TLS is automatic |
| `POSTGRES_PASSWORD` | yes | Database password, hex only |
| `VAPID_PRIVATE_KEY` | yes | Web Push signing key (server); the matching public key is served at `/v1/push-key` |
| `MESSAGE_TTL_DAYS` | no (`30`) | Days an undelivered message is kept before it is dropped |
| `TURN_URLS`, `TURN_SECRET` | no | Call relay, see below |
| `TURN_REALM`, `TURN_EXTERNAL_IP` | with the relay | coturn settings |
| `VITE_STUN_URL` | no | STUN server when you run no relay |
| `HTTP_PORT`, `HTTPS_PORT` | no | Published ports (80, 443) |

`VITE_*` values are compiled into the web build: changing one means `docker compose up -d --build`.

### Using a copy of the app your instance did not serve

An instance that also serves the web app could serve a modified one that leaks your keys. To avoid trusting the host with that, build a copy that is not tied to any server and run it yourself:

```sh
docker build -f deploy/web.Dockerfile --target client-files \
  --build-arg VITE_REQUIRE_SERVER_URL=1 --output client .
cd client && python3 -m http.server 8080 --bind 127.0.0.1     # or any static file server
```

The build runs in Docker (it compiles the WebAssembly part), so the host needs neither Rust nor Node. Open `http://localhost:8080`: the browser only enables the crypto APIs the app needs on `localhost` or over HTTPS. On first launch it asks for the server address (`https://...`, or `http://localhost` for a local one) and talks to it directly; every instance accepts requests from another origin. The compose stack's own web service keeps the same-origin behaviour and shows a warning under Settings, Server, that its host could change the app. The build carries its own Content-Security-Policy (a meta tag; this copy may connect to any `https` server and to localhost, the instance-served one only to itself). If you serve it behind your own headers, do not set a stricter `connect-src`. Building it yourself from source you read is the strongest option; a signed release (next section) saves you the build.

### Releases and the web page

Pushing a version tag (`v*`) runs `.github/workflows/release.yml`: it builds the client above in CI, packs it deterministically and publishes `umbrachat-client-<tag>.tar.gz` and `SHA256SUMS` as a release. The archive is signed with a GitHub build-provenance attestation (Sigstore): no private key to keep, and anyone can check that the file was built by this repository's workflow from a given commit.

```sh
gh attestation verify umbrachat-client-v1.0.0.tar.gz --repo UmbraChat/UmbraChat
mkdir client && tar -xzf umbrachat-client-v1.0.0.tar.gz -C client
cd client && python3 -m http.server 8080 --bind 127.0.0.1
```

What the signature proves, and what it does not: the archive comes from this repository's workflow and the commit it names. It does not prove the commit is honest (read the source, or trust whoever controls the repository), and it protects nobody who skips the check.

The workflow can also publish the same client as a web page (GitHub Pages), for people who want no install. It is off: set the repository variable `PUBLISH_PAGE` to `true` and Pages source to "GitHub Actions". Before you do:

- A page serves the same JavaScript to everyone from one place: a hijacked account or CI would reach every user at once, and a visitor cannot verify the page against the signed release. It is a convenience, the local install stays the safe path; say so on the page you publish.
- Host it from an organization dedicated to the client, with two-factor authentication required for every member and the `v*` release tags protected by a ruleset. A page is only as safe as the accounts that can publish it.
- The app has to sit at the root of its origin (`/sw.js`, `start_url: "/"`): use a custom domain or a repository named `<owner>.github.io`. At `<owner>.github.io/UmbraChat/` it breaks.

### Calls on hard networks (optional relay)

Without a relay, calls only work when the two devices can reach each other directly. Phones on mobile data and strict firewalls usually cannot. To add a relay, point a DNS name at a machine with a public IP, open UDP 3478 and 49152-49252 on it, and set in `.env`:

```sh
TURN_URLS=turn:turn.example.org:3478?transport=udp,stun:turn.example.org:3478
TURN_SECRET=<openssl rand -hex 32>
TURN_REALM=turn.example.org
TURN_EXTERNAL_IP=<public IP of that machine>
```

Then `docker compose --profile relay up -d`. The server hands each call short-lived credentials derived from `TURN_SECRET`; nothing static ships in the web bundle. That stops credentials from being reused outside the app, not abuse by registered users: registration is open, so anyone who registers on your instance can obtain credentials, and only `total-quota` in `deploy/coturn/turnserver.conf` caps the relay's load. The relay carries encrypted media only. It does **not** hide callers' IP addresses from each other: WebRTC still exchanges direct candidates and uses the relay only as a fallback.

By default no third-party STUN server is contacted by the call code.

### Operating it

- **Backups:** `docker compose exec db pg_dump -U umbrachat umbrachat > backup.sql`. Losing the database loses accounts and queued messages; users keep their keys locally but must re-register.
- **Upgrades:** `git pull && docker compose up -d --build`. Protocol 2 (signed device lists) changed registration: accounts created before it cannot be used on a server running it, so a test instance is wiped and re-registered. An app and a server must run exactly the same protocol version (`PROTOCOL_VERSION`): the server refuses an app of another version, and an app refuses a server of another version, with an "Update needed" screen instead of failing in odd ways. The web app served by the stack is rebuilt together with the server; a locally installed copy must be rebuilt after an upgrade that changes the version. This guards against out-of-date sides, not against a malicious server, which can claim any version.
- **Logs:** Caddy has no access log configured, the server logs almost nothing and the relay's logs are switched off, so client IPs are not kept by UmbraChat. Your host, network and cloud provider may still log them.

## Authenticating a contact: the invite

Under "Your Identity", "Show my invite" gives a string made of your account id and the fingerprint of your account's very first signed device list. A contact who pastes it in "New Conversation" instead of a bare account id gets a chain checked against that fingerprint: if the server shows anything that does not descend from it, the app refuses and pins nothing. Without an invite, the first chain a server shows is trusted as is.

Give the invite over a channel the server does not control (in person, a call, a messenger you trust). Whoever can swap it in transit can swap the account. An invite does not change after you add devices, so it can be reused; it proves who you are, not that your current devices are the ones you meant (the signed device list does that).

## What the server stores

Account ids and creation time; device ids, labels and creation time; each device's public keys; each account's signed device-list statements (public, signed by the account's own devices); queued ciphertext together with sender account/device id, recipient device id and timestamp (deleted when the recipient fetches it, or after `MESSAGE_TTL_DAYS` if they never do); push subscription endpoints and keys; short-lived device-link codes. It cannot read message contents, files, call media or groups' content.

It does see, and could be compelled to hand over, who has an account, how many devices, and, while a message is queued, who is writing to whom and when.

## Limits, stated plainly

- **You trust whoever serves the web app.** A web client cannot prove the JavaScript it runs is the audited one: a compromised or coerced operator could serve a modified bundle that leaks keys. This is the central weakness of any web messenger.
- Each account has a signed device list: a chain of statements, each signed by a device that was in the one before. Your client keeps the last list it verified for every contact, trusting the first one it sees (like a first key) and accepting only valid continuations after that. It sends only to the devices in that list, uses only the key listed for each, and refuses (and shows you a notice about) a message from a device that is not in it: there is no "accept anyway". Every message carries the sender's list version and head, so a server that withholds a newer list, such as the removal of a stolen device, is exposed by the sender's own next message. A new device of your own account is accepted by comparing a number shown on both devices; any remaining device may remove a lost one, and without another device or an exported backup a lost account is lost. Limits: the first list you see for someone is trusted as is unless you started from their invite (below); a stolen device can race to remove your legitimate ones before you react; a server can still drop messages, and show different people different lists until a message of the sender's exposes it.
- Web Push goes through your browser vendor's push service (Google, Mozilla or Apple), which learns when a device has a queued message, never its content. Users can leave notifications off.
- iOS Safari may evict a PWA's local data after about seven days without a visit, which destroys the keys on that device. Keep a backup export.
- Message delivery and call signaling use 3-second polling, not push connections.
- No federation, no native apps, no formal security audit.

## License and responsibility

AGPL-3.0-only (see `LICENSE`). The license is not a free choice: the project links the official `libsignal`, which is AGPL-3.0. If you modify UmbraChat and let others use your instance, section 13 requires you to offer them the source of your version.

The license disclaims all warranty and liability. It does not decide your legal position as the operator of a messaging service, which depends on where you are. Check that before opening an instance to other people.

## Development

See `CONTRIBUTING.md`.

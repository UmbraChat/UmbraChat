# Project Brief

## What it is

UmbraChat is an open-source, self-hostable end-to-end encrypted messenger (Signal-like): text, files, voice/video calls, and groups, all E2E encrypted.

## Why it exists

Built to give a privacy-first alternative that resists mandated client-side content scanning (EU "ChatControl"-style regulation): no party, including the server operator, can access plaintext content. Solo-maintained and distributed as software to self-host: the maintainer runs no public instance, and each instance is independent (no federation).

## Domain language

| Term | Meaning |
| ---- | ------- |
| Zero-knowledge server | The server stores and relays only encrypted envelopes and public prekey bundles; it never holds the keys to decrypt content |
| Prekey bundle | The public key material a client publishes so others can start an encrypted session with it (X3DH) |
| Envelope | An encrypted message/call-signaling payload as seen by the server; opaque without the recipient's private key |
| Sideload | Installing the iOS/Android app outside an app store (AltStore/SideStore on iOS with a free Apple ID, direct APK on Android) — the $0-cost distribution path |

## Key features

- E2E encrypted messages and files
- E2E encrypted voice/video calls
- E2E encrypted groups
- Disappearing messages
- Multi-device sync
- Self-destructing files
- Screenshot detection
- Offline message queue, synced on reconnect

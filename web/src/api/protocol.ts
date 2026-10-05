/**
 * Version of everything an app and a server must agree on to talk at all: the HTTP API and the
 * format of the envelopes it carries. Compared for strict equality, in both directions, before
 * anything else: any difference means "update". It does not guard against a malicious server
 * (which can claim any version), only against talking to a server or an app that is out of date.
 * Bump it with every change an older or newer side could misread, together with
 * server/src/protocol.rs (a server test checks that they match).
 */
export const PROTOCOL_VERSION = 2;
export const PROTOCOL_HEADER = "x-umbra-protocol";

export interface ProtocolMismatch {
  /** The version the server announced, or undefined if it announced none (not an UmbraChat server, or an old one). */
  server: number | undefined;
}

export class ProtocolMismatchError extends Error {
  mismatch: ProtocolMismatch;

  constructor(mismatch: ProtocolMismatch) {
    super(describeMismatch(mismatch));
    this.mismatch = mismatch;
  }
}

export function describeMismatch({ server }: ProtocolMismatch): string {
  if (server === undefined) return "this address does not answer like an UmbraChat server of this version (it may be an older build, or not UmbraChat)";
  if (server > PROTOCOL_VERSION) return `version mismatch: the server speaks UmbraChat protocol ${server}, this app speaks ${PROTOCOL_VERSION}. Update the app: both sides must run the same build`;
  return `version mismatch: the server speaks UmbraChat protocol ${server}, this app speaks ${PROTOCOL_VERSION}. The server is not updated yet: both sides must run the same build`;
}

let current: ProtocolMismatch | undefined;
const listeners = new Set<(m: ProtocolMismatch | undefined) => void>();

export function getProtocolMismatch(): ProtocolMismatch | undefined {
  return current;
}

export function subscribeToProtocolMismatch(listener: (m: ProtocolMismatch | undefined) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Checks a response against this app's version; throws, and blocks the whole app, on any difference. */
export function assertSameProtocol(response: Response): void {
  const raw = response.headers.get(PROTOCOL_HEADER);
  const server = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined;
  if (server === PROTOCOL_VERSION) return;
  current = { server };
  for (const listener of listeners) listener(current);
  throw new ProtocolMismatchError(current);
}

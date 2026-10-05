import { loadSession, saveSession } from "../storage/keyStore";
import { fromBase64, toBase64 } from "../api/codec";
import type { ReceivedMessage } from "../api/messages";

/**
 * Fetching a message deletes it on the server, so a message that could not be processed only
 * because something was temporarily unreachable (the sender's device list, say) would be lost.
 * Those wait here, encrypted on disk like the rest of the local store, until the next poll.
 */
const KEY = "@retry"; // no colon: not a session address, but carried by backup and vault migration like one
const MAX_WAITING = 200;

interface Stored {
  senderAccountId: string;
  senderDeviceId: string;
  envelope: string; // base64
  createdAt: string;
}

let chain: Promise<unknown> = Promise.resolve();
const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
  const run = chain.then(work);
  chain = run.catch(() => undefined);
  return run;
};

async function read(): Promise<Stored[]> {
  const bytes = await loadSession(KEY);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as Stored[]) : [];
}

const write = (items: Stored[]) => saveSession(KEY, new TextEncoder().encode(JSON.stringify(items)));

export function holdForRetry(message: ReceivedMessage): Promise<void> {
  return exclusive(async () => {
    const items = await read();
    if (items.length >= MAX_WAITING) return;
    items.push({ senderAccountId: message.senderAccountId, senderDeviceId: message.senderDeviceId, envelope: toBase64(message.envelope), createdAt: message.createdAt });
    await write(items);
  });
}

/** Everything waiting, oldest first; the queue is emptied (a message that fails again goes back with holdForRetry). */
export function takeRetries(): Promise<ReceivedMessage[]> {
  return exclusive(async () => {
    const items = await read();
    if (items.length === 0) return [];
    await write([]);
    return items.map((m) => ({ senderAccountId: m.senderAccountId, senderDeviceId: m.senderDeviceId, envelope: fromBase64(m.envelope), createdAt: m.createdAt }));
  });
}

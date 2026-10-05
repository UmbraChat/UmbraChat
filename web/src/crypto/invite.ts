/**
 * An invite is how a contact is authenticated the first time: the account id plus the head of the
 * account's very first signed device list, which never changes. A client that holds it accepts
 * only a chain that descends from that exact list, so a server cannot substitute another one.
 * It must reach the other person over a channel the server does not control (in person, a call, a
 * message app you trust): whoever can swap the invite in transit can swap the account.
 */
const INVITE = /^umbra:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

export interface Invite {
  accountId: string;
  /** Hex of the head of the account's first statement. */
  genesis: string;
}

export const formatInvite = (accountId: string, genesis: string): string => `umbra:${accountId}.${genesis}`;

export function parseInvite(text: string): Invite | null {
  const m = INVITE.exec(text.trim().toLowerCase());
  return m ? { accountId: m[1], genesis: m[2] } : null;
}

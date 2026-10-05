import type { SignalStore } from "wasm-crypto";
import type { LocalAccount } from "../storage/keyStore";
import { sendToContact, type GroupEnvelope } from "./conversation";
import { loadGroup, saveGroup, type Group } from "../storage/groupStore";
import { updateMessages, type ChatMessage } from "../storage/messageStore";

export { loadAllGroups, type Group } from "../storage/groupStore";

function otherMembers(group: Group, account: LocalAccount): string[] {
  return group.memberAccountIds.filter((id) => id !== account.accountId);
}

export async function createGroup(name: string, otherMemberAccountIds: string[], account: LocalAccount, store: SignalStore): Promise<string> {
  const groupId = crypto.randomUUID();
  // The roster is the *full* membership, including the caller - every
  // recipient saves this exact array unmodified, so its meaning can't depend
  // on whose device it lands on. Filtering yourself out only happens at
  // fan-out time (see otherMembers), never in what's stored or sent.
  const memberAccountIds = [account.accountId, ...otherMemberAccountIds];
  await saveGroup({ id: groupId, name, memberAccountIds, createdAt: new Date().toISOString() });

  const plaintext = new TextEncoder().encode(JSON.stringify({ type: "group-invite", groupId, name, memberAccountIds } satisfies GroupEnvelope));
  for (const memberAccountId of otherMemberAccountIds) {
    await sendToContact(memberAccountId, plaintext, account, store);
  }
  return groupId;
}

export async function sendGroupText(groupId: string, text: string, account: LocalAccount, store: SignalStore): Promise<ChatMessage[]> {
  const group = await loadGroup(groupId);
  if (!group) throw new Error("unknown group");

  const id = crypto.randomUUID();
  const plaintext = new TextEncoder().encode(JSON.stringify({ type: "group-text", groupId, id, body: text } satisfies GroupEnvelope));
  for (const memberAccountId of otherMembers(group, account)) {
    await sendToContact(memberAccountId, plaintext, account, store);
  }

  return updateMessages(groupId, (messages) => {
    messages.push({ id, direction: "sent", text, status: "sent", createdAt: new Date().toISOString() });
  });
}

export async function removeMember(groupId: string, memberAccountId: string, account: LocalAccount, store: SignalStore): Promise<Group> {
  const group = await loadGroup(groupId);
  if (!group) throw new Error("unknown group");

  const updated: Group = { ...group, memberAccountIds: group.memberAccountIds.filter((id) => id !== memberAccountId) };
  await saveGroup(updated);

  // Fanned out to the *new* roster only (still full membership, including the
  // caller, per the same convention) - the removed member is never sent this.
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ type: "group-update", groupId, memberAccountIds: updated.memberAccountIds } satisfies GroupEnvelope),
  );
  for (const remaining of otherMembers(updated, account)) {
    await sendToContact(remaining, plaintext, account, store);
  }
  return updated;
}

/**
 * Reacts to an incoming group-* envelope, routed here by conversation.ts's
 * poll() regardless of which 1:1 contact or group is currently open. Purely
 * reactive - never sends anything itself, so it doesn't need account/store.
 */
export async function handleGroupSignal(envelope: GroupEnvelope, senderAccountId: string): Promise<void> {
  if (envelope.type === "group-invite") {
    await saveGroup({ id: envelope.groupId, name: envelope.name, memberAccountIds: envelope.memberAccountIds, createdAt: new Date().toISOString() });
    return;
  }

  if (envelope.type === "group-update") {
    const existing = await loadGroup(envelope.groupId);
    // Ignore an update for a group we don't know, and - the actual security
    // check - ignore one from a sender who isn't currently one of ITS members.
    // Without this, anyone who ever learns a groupId could rewrite a
    // recipient's view of who's in it, including a member who was already
    // removed trying to add themselves back.
    if (!existing || !existing.memberAccountIds.includes(senderAccountId)) return;
    await saveGroup({ ...existing, memberAccountIds: envelope.memberAccountIds });
    return;
  }

  // group-text
  const group = await loadGroup(envelope.groupId);
  // Removal enforcement: a message is only accepted from a sender still in
  // *my* local roster for this group - see plan.md's Decisions for why this,
  // not a shared group key, is what "removal" actually guarantees here.
  if (!group || !group.memberAccountIds.includes(senderAccountId)) return;

  await updateMessages(envelope.groupId, (messages) => {
    messages.push({
      id: envelope.id,
      direction: "received",
      text: envelope.body,
      status: "delivered",
      createdAt: new Date().toISOString(),
      senderAccountId,
    });
  });
}

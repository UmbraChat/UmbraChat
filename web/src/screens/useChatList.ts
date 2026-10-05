import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listMessageContactIds, loadMessages, onMessagesChanged, type ChatMessage } from "../storage/messageStore";
import { loadAllNicknames } from "../storage/nicknameStore";
import type { Group } from "../chat/group";

export interface ChatEntry {
  id: string;
  kind: "contact" | "group";
  name: string;
  preview: string;
  /** ISO time of the last message, or of the group's creation when it has none. */
  at?: string;
  unread: boolean;
}

interface Summary {
  last?: ChatMessage;
  /** Received 1:1 messages nobody has opened yet ("read" is only set when the conversation is opened). */
  unread: number;
}

function summarize(messages: ChatMessage[]): Summary {
  return {
    last: messages.at(-1),
    unread: messages.filter((m) => m.direction === "received" && m.status === "delivered").length,
  };
}

function previewOf(m: ChatMessage | undefined): string {
  if (!m) return "No messages yet";
  return m.file ? `File · ${m.file.filename}` : m.text;
}

/**
 * The conversation list, built from local history. Every history write goes through
 * updateMessages, which reports it here, so the list follows without reading storage again.
 * It only reads: opening a conversation is what sends read receipts, never this list.
 */
export function useChatList(accountId: string | undefined, groups: Group[], openId: string | undefined) {
  const [summaries, setSummaries] = useState(new Map<string, Summary>());
  const [nicknames, setNicknames] = useState(new Map<string, string>());
  // Group messages have no read state of their own: unread is kept for this session only.
  const [unreadGroups, setUnreadGroups] = useState(new Set<string>());
  const openRef = useRef(openId);
  openRef.current = openId;

  const refreshNicknames = useCallback(() => {
    loadAllNicknames().then(setNicknames, (err) => console.warn("could not load nicknames:", err));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    const off = onMessagesChanged((id, messages) => {
      setSummaries((prev) => new Map(prev).set(id, summarize(messages)));
      // Only received group messages carry a sender id.
      const last = messages.at(-1);
      if (last?.direction === "received" && last.senderAccountId && id !== openRef.current) {
        setUnreadGroups((prev) => new Set(prev).add(id));
      }
    });
    (async () => {
      // ponytail: decrypts every stored history once per sign-in, files included; keep a
      // separate index of last messages if that gets slow.
      const ids = await listMessageContactIds();
      const loaded = await Promise.all(ids.map(async (id) => [id, summarize(await loadMessages(id))] as const));
      if (!live) return;
      // A write that landed while this was loading is newer than what was read.
      setSummaries((prev) => new Map([...loaded, ...prev]));
    })().catch((err) => console.warn("could not load the chat list:", err));
    refreshNicknames();
    return () => {
      live = false;
      off();
    };
  }, [accountId, refreshNicknames]);

  useEffect(() => {
    if (!openId) return;
    setUnreadGroups((prev) => {
      if (!prev.has(openId)) return prev;
      const next = new Set(prev);
      next.delete(openId);
      return next;
    });
  }, [openId]);

  const entries = useMemo(() => {
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const list: ChatEntry[] = [];
    for (const [id, summary] of summaries) {
      const group = groupById.get(id);
      if (group) continue;
      list.push({
        id,
        kind: "contact",
        name: nicknames.get(id) ?? id,
        preview: previewOf(summary.last),
        at: summary.last?.createdAt,
        unread: summary.unread > 0 && id !== openId,
      });
    }
    // A conversation just started has no history yet, but it is open: list it.
    if (openId && !summaries.has(openId) && !groupById.has(openId)) {
      list.push({ id: openId, kind: "contact", name: nicknames.get(openId) ?? openId, preview: previewOf(undefined), unread: false });
    }
    for (const group of groups) {
      const last = summaries.get(group.id)?.last;
      list.push({
        id: group.id,
        kind: "group",
        name: group.name,
        preview: previewOf(last),
        at: last?.createdAt ?? group.createdAt,
        unread: unreadGroups.has(group.id) && group.id !== openId,
      });
    }
    return list.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }, [summaries, nicknames, groups, unreadGroups, openId]);

  return { entries, refreshNicknames };
}

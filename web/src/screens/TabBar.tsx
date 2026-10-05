import { ChatsIcon, MeIcon, SettingsIcon } from "./icons";

export type Tab = "chats" | "me" | "settings";

const TABS: { id: Tab; label: string; Icon: () => React.JSX.Element }[] = [
  { id: "chats", label: "Chats", Icon: ChatsIcon },
  { id: "me", label: "Me", Icon: MeIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

export function TabBar({ tab, onSelect, unread }: { tab: Tab; onSelect: (tab: Tab) => void; unread: boolean }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {TABS.map(({ id, label, Icon }) => (
        <button key={id} className="tab" data-testid={`tab-${id}`} aria-current={tab === id ? "page" : undefined} onClick={() => onSelect(id)}>
          <span className="tab-icon">
            <Icon />
            {id === "chats" && unread && <span className="dot" aria-label="unread messages" />}
          </span>
          {label}
        </button>
      ))}
    </nav>
  );
}

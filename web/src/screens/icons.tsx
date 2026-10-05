// Small inline icons: no icon font or sprite request, and they take the text colour.
const svg = { viewBox: "0 0 24 24", "aria-hidden": true, focusable: false } as const;

export const PhoneIcon = () => (
  <svg {...svg}>
    <path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
  </svg>
);

export const VideoIcon = () => (
  <svg {...svg}>
    <path d="M15 8v8H5V8zm1-2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4V7a1 1 0 0 0-1-1" />
  </svg>
);

export const MoreIcon = () => (
  <svg {...svg}>
    <circle cx="12" cy="5" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="12" cy="19" r="2" />
  </svg>
);

export const SendIcon = () => (
  <svg {...svg}>
    <path d="M12 4l7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...svg}>
    <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
  </svg>
);

export const ChatsIcon = () => (
  <svg {...svg}>
    <path d="M7 4.5h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-6.5L6 20v-3.6A3 3 0 0 1 4 13.5v-6a3 3 0 0 1 3-3z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
  </svg>
);

export const MeIcon = () => (
  <svg {...svg}>
    <path d="M12 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm-8 10a8 8 0 0 1 16 0h-2a6 6 0 0 0-12 0z" />
  </svg>
);

export const SettingsIcon = () => (
  <svg {...svg}>
    <path d="M4 7h16v2H4zm0 8h16v2H4z" />
    <circle cx="16" cy="8" r="2.6" />
    <circle cx="8" cy="16" r="2.6" />
  </svg>
);

/** UmbraChat's mark: a disk almost all in shadow, its lit rim a U. Same shape as public/favicon.svg. */
export const Logo = () => (
  <svg className="logo" viewBox="12 24.2 40 28.8" aria-hidden focusable={false}>
    <path d="M14.04 24.2A20 20 0 1 0 49.96 24.2A18 18 0 0 1 14.04 24.2Z" />
  </svg>
);

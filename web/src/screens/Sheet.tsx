import { useEffect, useRef, type ReactNode } from "react";
import { subscribeToCallState } from "../chat/call";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}

/**
 * A panel that slides up over the dimmed screen. A native modal <dialog>, so focus stays inside,
 * Escape closes it and the page behind is inert. An incoming call closes it: the call screen
 * would otherwise sit under it, out of reach.
 */
export function Sheet({ open, onClose, label, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Checked first: StrictMode runs this effect twice, and showModal() throws on an open dialog.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => subscribeToCallState((call) => call.status === "incoming-ringing" && onCloseRef.current()), []);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click on the dialog element itself, not its content, landed on the backdrop.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet-body">
        <span className="grip" aria-hidden />
        {children}
      </div>
    </dialog>
  );
}

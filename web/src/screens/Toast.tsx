import { useEffect, useState } from "react";

const EVENT = "umbrachat:toast";
const SHOWN_MS = 2200;

/** A short confirmation at the bottom of the screen, from anywhere in the app. */
export function showToast(text: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: text }));
}

export function Toast() {
  const [toast, setToast] = useState<{ text: string; n: number }>();

  useEffect(() => {
    let timer: number | undefined;
    let n = 0;
    function onToast(e: Event) {
      setToast({ text: (e as CustomEvent<string>).detail, n: ++n });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToast(undefined), SHOWN_MS);
    }
    window.addEventListener(EVENT, onToast);
    return () => {
      window.removeEventListener(EVENT, onToast);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="toast-region" aria-live="polite">
      {/* Keyed so the rise animation replays for each new toast. */}
      {toast && (
        <p key={toast.n} className="toast">
          {toast.text}
        </p>
      )}
    </div>
  );
}

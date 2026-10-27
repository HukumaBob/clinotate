import { useEffect, useState } from "react";

/** Toggles the browser's fullscreen mode for the whole page (the same
 * effect as F11, but reachable by mouse). Esc leaves fullscreen without
 * going through the button, so the state follows `fullscreenchange`. */
export function FullscreenButton() {
  const [active, setActive] = useState(() => document.fullscreenElement !== null);

  useEffect(() => {
    const sync = () => setActive(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  if (!document.fullscreenEnabled) return null;

  function toggle() {
    const result = active ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    // A refusal (no user gesture, a sandboxed frame) leaves the mode as it was.
    result.catch(() => undefined);
  }

  const label = active ? "Exit full screen" : "Enter full screen";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded text-gray-300 hover:bg-gray-800 hover:text-gray-100"
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        {active ? (
          <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" />
        ) : (
          <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
        )}
      </svg>
    </button>
  );
}

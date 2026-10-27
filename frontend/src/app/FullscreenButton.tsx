import { useEffect, useState } from "react";

const DISPLAY_MODE = "(display-mode: fullscreen)";

/** Toggles the browser's fullscreen mode for the whole page (the same
 * effect as F11, but reachable by mouse). Two things can put the page in
 * fullscreen: this button (Fullscreen API, reported by `fullscreenchange`,
 * also fired by Esc) and F11 (reported only by the `display-mode` media
 * query, and a page cannot leave it). */
export function FullscreenButton() {
  const [api, setApi] = useState(() => document.fullscreenElement !== null);
  const [f11, setF11] = useState(() => window.matchMedia?.(DISPLAY_MODE).matches ?? false);

  useEffect(() => {
    const syncApi = () => setApi(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", syncApi);

    const query = window.matchMedia?.(DISPLAY_MODE);
    const syncMode = () => setF11(query?.matches ?? false);
    query?.addEventListener("change", syncMode);
    return () => {
      document.removeEventListener("fullscreenchange", syncApi);
      query?.removeEventListener("change", syncMode);
    };
  }, []);

  if (!document.fullscreenEnabled) return null;

  const active = api || f11;
  const locked = f11 && !api;

  function toggle() {
    const result = api ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    // A refusal (no user gesture, a sandboxed frame) leaves the mode as it was.
    result.catch(() => undefined);
  }

  const label = active ? "Exit full screen" : "Enter full screen";
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={locked}
      aria-label={label}
      title={locked ? "Press F11 to exit full screen" : label}
      className="flex h-8 w-8 items-center justify-center rounded text-gray-300 hover:bg-gray-800 hover:text-gray-100 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
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

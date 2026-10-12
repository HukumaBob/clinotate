import { useEffect, useMemo, useRef } from "react";

import { cleanLog, foldArchitecture } from "./cleanLog";

/** Pixels of slack between the visible bottom edge and the true bottom of the
 * content before the reader no longer counts as "at the bottom" (sub-pixel
 * rounding and zoom make scrollTop + clientHeight rarely equal scrollHeight). */
export const STICK_TO_BOTTOM_TOLERANCE_PX = 24;

/** Pure decision for the follow-the-tail pattern, separate so it can be tested
 * without jsdom layout (jsdom reports 0 for every scroll metric). */
export function shouldStickToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance: number = STICK_TO_BOTTOM_TOLERANCE_PX,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= tolerance;
}

interface LogViewProps {
  text: string;
  className?: string;
}

export function LogView({ text, className = "" }: LogViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Whether the reader was at the bottom just before this update, so new
  // output only moves the view when they were following it.
  const followingRef = useRef(true);
  const cleaned = useMemo(() => cleanLog(text), [text]);
  const folded = useMemo(() => foldArchitecture(cleaned), [cleaned]);

  useEffect(() => {
    const el = ref.current;
    if (el && followingRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [cleaned]);

  return (
    <div
      ref={ref}
      role="log"
      aria-live="off"
      onScroll={(event) => {
        const el = event.currentTarget;
        followingRef.current = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
      }}
      className={`max-h-[60vh] min-h-[24rem] overflow-auto rounded border border-gray-800 bg-gray-950 p-3 font-mono text-xs text-gray-300 ${className}`}
    >
      {cleaned === "" ? (
        <pre className="whitespace-pre-wrap">No log output yet.</pre>
      ) : folded.architecture === null ? (
        <pre className="whitespace-pre-wrap">{cleaned}</pre>
      ) : (
        <>
          {folded.before !== "" && <pre className="whitespace-pre-wrap">{folded.before}</pre>}
          <details className="my-1">
            <summary className="cursor-pointer text-gray-400">
              Model architecture ({folded.architecture.length} lines)
            </summary>
            <pre className="whitespace-pre-wrap">{folded.architecture.join("\n")}</pre>
          </details>
          {folded.after !== "" && <pre className="whitespace-pre-wrap">{folded.after}</pre>}
        </>
      )}
    </div>
  );
}

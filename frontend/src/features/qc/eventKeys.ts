// Input types that do not take typed text: a focused slider or checkbox must
// not block the event-navigation keys.
const NON_TYPING_INPUT_TYPES = new Set([
  "range",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "image",
]);

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") {
    return !NON_TYPING_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  return false;
}

/** [ and ] by character or by physical key, so any keyboard layout works. */
export function eventDirectionFor(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">,
): "prev" | "next" | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.code === "BracketLeft" || event.key === "[") return "prev";
  if (event.code === "BracketRight" || event.key === "]") return "next";
  return null;
}

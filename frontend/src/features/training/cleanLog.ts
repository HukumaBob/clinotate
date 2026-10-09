/** Readable form of a raw trainer log, for display only (the stored log stays raw).
 *
 * Ultralytics writes every progress-bar update as its own line that starts with a
 * carriage return and an ANSI "erase line" code and carries the whole bar. Shown
 * verbatim that is hundreds of near-identical lines full of control characters.
 * Here the control codes are removed and consecutive updates of the same bar are
 * folded into the last one. */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// A bar is "<digits>% " followed by a run of box-drawing glyphs: a plain line that
// merely mentions a percentage is not a bar.
const PROGRESS = /\d+%\s*[━─╸╺╾╼]{3,}/;

function firstToken(line: string): string {
  return line.trim().split(/\s+/)[0] ?? "";
}

export function cleanLog(raw: string): string {
  if (raw === "") {
    return "";
  }
  const out: string[] = [];
  let barKey: string | null = null;
  for (const rawLine of raw.split("\n")) {
    // A carriage return rewinds the cursor, so only what follows the last one is visible.
    const visible = rawLine.split("\r").filter((part) => part !== "").pop() ?? "";
    const line = visible.replace(ANSI, "").replace(/\s+$/, "");
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      barKey = null;
      continue;
    }
    if (PROGRESS.test(line)) {
      // Updates of one bar share their first token (the epoch "2/3", "Class", "train:").
      const key = firstToken(line);
      if (barKey === key) {
        out[out.length - 1] = line;
      } else {
        out.push(line);
        barKey = key;
      }
    } else {
      out.push(line);
      barKey = null;
    }
  }
  return out.join("\n").replace(/\n+$/, "");
}

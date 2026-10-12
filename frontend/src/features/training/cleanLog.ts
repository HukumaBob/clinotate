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

export interface FoldedLog {
  /** Cleaned lines before the model-architecture block. */
  before: string;
  /** The block itself (header through the "summary:" line), or null when absent. */
  architecture: string[] | null;
  /** Cleaned lines after the block. */
  after: string;
}

const ARCH_HEADER = /^\s*from\s+n\s+params\s+module\s+arguments/;
const ARCH_ROW = /^\s*\d+\s+\S/;
const ARCH_SUMMARY = /^\S*\s*summary:/;

/** Splits an already cleaned log around the Ultralytics model-architecture table
 * (the `from  n  params  module  arguments` header, one row per layer, and the
 * `YOLO11n summary:` line) so the view can fold it. A table still being written
 * (no summary line yet) folds as far as it goes. */
export function foldArchitecture(cleaned: string): FoldedLog {
  const lines = cleaned.split("\n");
  const start = lines.findIndex((line) => ARCH_HEADER.test(line));
  if (start === -1) {
    return { before: cleaned, architecture: null, after: "" };
  }
  let end = start + 1;
  while (end < lines.length && ARCH_ROW.test(lines[end])) {
    end += 1;
  }
  if (end < lines.length && ARCH_SUMMARY.test(lines[end])) {
    end += 1;
  }
  return {
    before: lines.slice(0, start).join("\n"),
    architecture: lines.slice(start, end),
    after: lines.slice(end).join("\n"),
  };
}

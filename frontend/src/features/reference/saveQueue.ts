import type { RefInterval } from "./types";

export interface SaveOps {
  create(vars: Omit<RefInterval, "id">): Promise<RefInterval>;
  update(vars: { intervalId: number; labelId?: number; startMs?: number; endMs?: number }): Promise<unknown>;
  remove(intervalId: number): Promise<unknown>;
}

export interface SaveListener {
  /** A created interval got its server id; replace the local id everywhere. */
  onRemap(localId: number, serverId: number): void;
  /** A save of this interval failed; the cache rolls back, the entry is gone. */
  onFail(id: number): void;
  /** Rows or state changed; re-render. */
  onChange(): void;
}

export type SaveState = "idle" | "saving" | "error";

interface Entry {
  /** Desired values (what the editor shows). */
  row: RefInterval;
  /** Values the server has (or was last sent); null while the create is in flight. */
  sent: RefInterval | null;
  deleted: boolean;
  busy: boolean;
  wantFlush: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Saves interval edits one request at a time per interval, always with the
 * newest desired values. A created interval keeps a local (negative) id until
 * the server answers; no update or delete is sent for it before that. */
export class SaveQueue {
  private entries = new Map<number, Entry>();
  private inFlight = 0;
  private failed = false;

  private ops: SaveOps;
  private listener: SaveListener;
  private throttleMs: number;

  constructor(ops: SaveOps, listener: SaveListener, throttleMs: number) {
    this.ops = ops;
    this.listener = listener;
    this.throttleMs = throttleMs;
  }

  rows(): { row: RefInterval; deleted: boolean }[] {
    return [...this.entries.values()].map((e) => ({ row: e.row, deleted: e.deleted }));
  }

  state(): SaveState {
    if (this.failed) return "error";
    return this.inFlight > 0 ? "saving" : "idle";
  }

  create(row: RefInterval): void {
    const entry: Entry = { row, sent: null, deleted: false, busy: true, wantFlush: false, timer: null };
    this.entries.set(row.id, entry);
    const { id: localId, ...vars } = row;
    this.track(this.ops.create(vars)).then(
      (created) => {
        if (this.entries.get(localId) !== entry) return;
        this.entries.delete(localId);
        entry.row = { ...entry.row, id: created.id };
        entry.sent = { ...created };
        this.entries.set(created.id, entry);
        entry.busy = false;
        this.listener.onRemap(localId, created.id);
        this.pump(entry);
      },
      () => this.fail(localId, entry),
    );
    this.listener.onChange();
  }

  /** Records `next` as the desired values of an interval currently shown as
   * `current`; "now" sends as soon as possible, "throttled" within throttleMs. */
  edit(current: RefInterval, next: RefInterval, mode: "now" | "throttled"): void {
    let entry = this.entries.get(current.id);
    if (!entry) {
      entry = { row: current, sent: current, deleted: false, busy: false, wantFlush: false, timer: null };
      this.entries.set(current.id, entry);
    }
    if (entry.deleted) return;
    entry.row = { ...next, id: entry.row.id };
    if (mode === "now") {
      this.requestFlush(entry);
    } else if (entry.timer === null) {
      const target = entry;
      entry.timer = setTimeout(() => {
        target.timer = null;
        this.requestFlush(target);
      }, this.throttleMs);
    }
    this.listener.onChange();
  }

  remove(current: RefInterval): void {
    let entry = this.entries.get(current.id);
    if (!entry) {
      entry = { row: current, sent: current, deleted: false, busy: false, wantFlush: false, timer: null };
      this.entries.set(current.id, entry);
    }
    entry.deleted = true;
    this.requestFlush(entry);
    this.listener.onChange();
  }

  flushAll(): void {
    for (const entry of [...this.entries.values()]) this.requestFlush(entry);
  }

  /** Clears timers; pending values are flushed first. */
  dispose(): void {
    this.flushAll();
  }

  private requestFlush(entry: Entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.wantFlush = true;
    this.pump(entry);
  }

  private pump(entry: Entry) {
    const sent = entry.sent;
    if (entry.busy || sent === null) return;
    if (entry.deleted) {
      if (!entry.wantFlush) return;
      entry.busy = true;
      entry.wantFlush = false;
      this.track(this.ops.remove(sent.id)).then(
        () => {
          this.entries.delete(sent.id);
          this.listener.onChange();
        },
        () => this.fail(sent.id, entry),
      );
      return;
    }
    const patch: { labelId?: number; startMs?: number; endMs?: number } = {};
    if (entry.row.labelId !== sent.labelId) patch.labelId = entry.row.labelId;
    if (entry.row.startMs !== sent.startMs) patch.startMs = entry.row.startMs;
    if (entry.row.endMs !== sent.endMs) patch.endMs = entry.row.endMs;
    if (Object.keys(patch).length === 0) {
      entry.wantFlush = false;
      if (entry.timer === null) this.entries.delete(entry.row.id);
      this.listener.onChange();
      return;
    }
    if (!entry.wantFlush) return;
    entry.busy = true;
    entry.wantFlush = false;
    const values = { ...entry.row };
    this.track(this.ops.update({ intervalId: sent.id, ...patch })).then(
      () => {
        entry.sent = values;
        entry.busy = false;
        this.pump(entry);
      },
      () => this.fail(sent.id, entry),
    );
  }

  private fail(id: number, entry: Entry) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (this.entries.get(id) === entry) this.entries.delete(id);
    this.failed = true;
    this.listener.onFail(id);
    this.listener.onChange();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.listener.onChange();
    return promise.then(
      (value) => {
        this.inFlight -= 1;
        this.failed = false;
        return value;
      },
      (error: unknown) => {
        this.inFlight -= 1;
        throw error;
      },
    );
  }
}

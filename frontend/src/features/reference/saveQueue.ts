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
  /** Values the server has (or was last sent); null until the create resolves. */
  sent: RefInterval | null;
  deleted: boolean;
  /** A request of this entry is in flight. */
  busy: boolean;
  /** Send as soon as the axis is free; flushOrder keeps the request order. */
  wantFlush: boolean;
  flushOrder: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Saves interval edits with the newest desired values. Requests are ordered
 * per axis (category): at most one is in flight per axis, and a create goes
 * out only after every pending edit of its axis is acknowledged, so the
 * server always sees the same sequence the editor validated. A created
 * interval keeps a local (negative) id until the server answers; nothing is
 * sent for it before that. Axes are independent of each other. */
export class SaveQueue {
  private entries = new Map<number, Entry>();
  private busyAxes = new Set<number>();
  private seq = 0;
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
    this.entries.set(row.id, {
      row,
      sent: null,
      deleted: false,
      busy: false,
      wantFlush: false,
      flushOrder: ++this.seq,
      timer: null,
    });
    this.pump(row.categoryId);
    this.listener.onChange();
  }

  /** Records `next` as the desired values of an interval currently shown as
   * `current`; "now" sends as soon as possible, "throttled" within throttleMs. */
  edit(current: RefInterval, next: RefInterval, mode: "now" | "throttled"): void {
    const entry = this.entryFor(current);
    if (entry.deleted) return;
    entry.row = { ...next, id: entry.row.id, categoryId: entry.row.categoryId };
    if (mode === "now") {
      this.requestFlush(entry);
    } else if (entry.timer === null && !entry.wantFlush) {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.requestFlush(entry);
      }, this.throttleMs);
    }
    this.listener.onChange();
  }

  remove(current: RefInterval): void {
    const entry = this.entryFor(current);
    entry.deleted = true;
    this.requestFlush(entry);
    this.listener.onChange();
  }

  flushAll(): void {
    for (const entry of [...this.entries.values()]) this.requestFlush(entry);
  }

  /** Pending values are flushed (called on unmount). */
  dispose(): void {
    this.flushAll();
  }

  private entryFor(current: RefInterval): Entry {
    let entry = this.entries.get(current.id);
    if (!entry) {
      entry = {
        row: current,
        sent: current,
        deleted: false,
        busy: false,
        wantFlush: false,
        flushOrder: 0,
        timer: null,
      };
      this.entries.set(current.id, entry);
    }
    return entry;
  }

  private requestFlush(entry: Entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.wantFlush) {
      entry.wantFlush = true;
      entry.flushOrder = ++this.seq;
    }
    this.pump(entry.row.categoryId);
  }

  private patchOf(entry: Entry) {
    const sent = entry.sent;
    const patch: { labelId?: number; startMs?: number; endMs?: number } = {};
    if (!sent) return patch;
    if (entry.row.labelId !== sent.labelId) patch.labelId = entry.row.labelId;
    if (entry.row.startMs !== sent.startMs) patch.startMs = entry.row.startMs;
    if (entry.row.endMs !== sent.endMs) patch.endMs = entry.row.endMs;
    return patch;
  }

  /** Sends the next request of one axis, if the axis is free. */
  private pump(categoryId: number) {
    if (this.busyAxes.has(categoryId)) return;
    const axis = [...this.entries.values()].filter((e) => e.row.categoryId === categoryId);
    const creates = axis.filter((e) => e.sent === null && !e.busy).sort((a, b) => a.flushOrder - b.flushOrder);
    for (const entry of axis) {
      if (entry.sent === null || entry.busy) continue;
      const pending = entry.deleted || Object.keys(this.patchOf(entry)).length > 0;
      if (!pending) {
        if (entry.timer === null) this.entries.delete(entry.row.id);
        entry.wantFlush = false;
      } else if (creates.length > 0 && !entry.wantFlush) {
        // A waiting create flushes every pending edit of its axis first.
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = null;
        entry.wantFlush = true;
        entry.flushOrder = ++this.seq;
      }
    }
    const edit = axis
      .filter((e) => e.sent !== null && e.wantFlush && this.entries.get(e.row.id) === e)
      .sort((a, b) => a.flushOrder - b.flushOrder)[0];
    if (edit) {
      this.sendEdit(edit);
      return;
    }
    if (creates.length > 0) this.sendCreate(creates[0]);
  }

  private run<T>(entry: Entry, request: Promise<T>, onDone: (value: T) => void, failId: number) {
    const categoryId = entry.row.categoryId;
    entry.busy = true;
    this.busyAxes.add(categoryId);
    this.inFlight += 1;
    this.listener.onChange();
    request.then(
      (value) => {
        this.inFlight -= 1;
        this.failed = false;
        entry.busy = false;
        this.busyAxes.delete(categoryId);
        onDone(value);
        this.listener.onChange();
        this.pump(categoryId);
      },
      () => {
        this.inFlight -= 1;
        entry.busy = false;
        this.busyAxes.delete(categoryId);
        if (entry.timer !== null) clearTimeout(entry.timer);
        if (this.entries.get(failId) === entry) this.entries.delete(failId);
        this.failed = true;
        this.listener.onFail(failId);
        this.listener.onChange();
        this.pump(categoryId);
      },
    );
  }

  private sendCreate(entry: Entry) {
    const localId = entry.row.id;
    const { id: _id, ...vars } = entry.row;
    void _id;
    this.run(
      entry,
      this.ops.create(vars),
      (created) => {
        if (this.entries.get(localId) !== entry) return;
        this.entries.delete(localId);
        entry.row = { ...entry.row, id: created.id };
        entry.sent = { ...created };
        this.entries.set(created.id, entry);
        this.listener.onRemap(localId, created.id);
      },
      localId,
    );
  }

  private sendEdit(entry: Entry) {
    const sent = entry.sent as RefInterval;
    entry.wantFlush = false;
    if (entry.deleted) {
      this.run(entry, this.ops.remove(sent.id), () => this.entries.delete(sent.id), sent.id);
      return;
    }
    const values = { ...entry.row };
    this.run(
      entry,
      this.ops.update({ intervalId: sent.id, ...this.patchOf(entry) }),
      () => {
        entry.sent = values;
      },
      sent.id,
    );
  }
}

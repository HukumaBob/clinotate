import { afterEach, describe, expect, it, vi } from "vitest";

import { SaveQueue, type SaveOps } from "./saveQueue";
import type { RefInterval } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const row = (id: number, startMs: number, endMs: number, labelId = 10): RefInterval => ({
  id,
  categoryId: 2,
  labelId,
  startMs,
  endMs,
});

function setup(ops: Partial<SaveOps> = {}) {
  const full: SaveOps = {
    create: vi.fn(async (v) => ({ id: 100, ...v })),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...ops,
  };
  const onRemap = vi.fn();
  const onFail = vi.fn();
  const onChange = vi.fn();
  const queue = new SaveQueue(full, { onRemap, onFail, onChange }, 1000);
  return { queue, ops: full, onRemap, onFail, onChange };
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("SaveQueue", () => {
  it("holds edits of a created interval until the server id arrives, then sends the newest", async () => {
    const create = deferred<RefInterval>();
    const { queue, ops, onRemap } = setup({ create: vi.fn(() => create.promise) });
    queue.create(row(-1, 0, 100));
    queue.edit(row(-1, 0, 100), row(-1, 0, 500), "now");
    queue.edit(row(-1, 0, 500), row(-1, 0, 900), "now");
    await flushPromises();
    expect(ops.update).not.toHaveBeenCalled();

    create.resolve(row(100, 0, 100));
    await flushPromises();
    expect(onRemap).toHaveBeenCalledWith(-1, 100);
    expect(ops.update).toHaveBeenCalledTimes(1);
    expect(ops.update).toHaveBeenCalledWith({ intervalId: 100, endMs: 900 });
  });

  it("serializes updates of one interval and coalesces to the newest value", async () => {
    const first = deferred<void>();
    const update = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { queue } = setup({ update });
    queue.edit(row(5, 0, 1000), row(5, 0, 2000), "now");
    queue.edit(row(5, 0, 2000), row(5, 0, 3000), "now");
    queue.edit(row(5, 0, 3000), row(5, 0, 4000), "now");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({ intervalId: 5, endMs: 2000 });

    first.resolve();
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith({ intervalId: 5, endMs: 4000 });
  });

  it("deletes a created interval only after its server id arrives", async () => {
    const create = deferred<RefInterval>();
    const { queue, ops } = setup({ create: vi.fn(() => create.promise) });
    queue.create(row(-1, 0, 100));
    queue.remove(row(-1, 0, 100));
    expect(queue.rows()).toEqual([{ row: row(-1, 0, 100), deleted: true }]);
    expect(ops.remove).not.toHaveBeenCalled();

    create.resolve(row(100, 0, 100));
    await flushPromises();
    expect(ops.remove).toHaveBeenCalledWith(100);
    expect(ops.update).not.toHaveBeenCalled();
  });

  it("a failed create drops the entry and reports the failure", async () => {
    const { queue, onFail } = setup({ create: vi.fn(async () => Promise.reject(new Error("409"))) });
    queue.create(row(-1, 0, 100));
    expect(queue.state()).toBe("saving");
    await flushPromises();
    expect(onFail).toHaveBeenCalledWith(-1);
    expect(queue.rows()).toEqual([]);
    expect(queue.state()).toBe("error");
  });

  it("throttled edits send at most once per interval of time", async () => {
    vi.useFakeTimers();
    const { queue, ops } = setup();
    let end = 1000;
    for (let i = 0; i < 25; i += 1) {
      queue.edit(row(5, 0, end), row(5, 0, end + 100), "throttled");
      end += 100;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(ops.update).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ops.update).toHaveBeenCalledTimes(3);
    expect(ops.update).toHaveBeenLastCalledWith({ intervalId: 5, endMs: end });
  });

  it("flushAll sends throttled edits immediately", async () => {
    vi.useFakeTimers();
    const { queue, ops } = setup();
    queue.edit(row(5, 0, 1000), row(5, 0, 1700), "throttled");
    queue.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.update).toHaveBeenCalledWith({ intervalId: 5, endMs: 1700 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ops.update).toHaveBeenCalledTimes(1);
  });

  it("forgets an entry once its values are saved", async () => {
    const { queue } = setup();
    queue.edit(row(5, 0, 1000), row(5, 0, 2000), "now");
    expect(queue.rows()).toHaveLength(1);
    await flushPromises();
    expect(queue.rows()).toEqual([]);
    expect(queue.state()).toBe("idle");
  });

  describe("per-axis ordering", () => {
    const other = (id: number, startMs: number, endMs: number): RefInterval => ({
      id,
      categoryId: 3,
      labelId: 20,
      startMs,
      endMs,
    });

    it("a create waits for a throttled edit of another interval on the axis", async () => {
      const held = deferred<void>();
      const update = vi.fn(() => held.promise);
      const { queue, ops } = setup({ update });
      queue.edit(row(5, 0, 5000), row(5, 0, 3000), "throttled");
      queue.create(row(-1, 3000, 3100, 11));
      expect(update).toHaveBeenCalledWith({ intervalId: 5, endMs: 3000 });
      expect(ops.create).not.toHaveBeenCalled();

      held.resolve();
      await flushPromises();
      expect(ops.create).toHaveBeenCalledWith({ categoryId: 2, labelId: 11, startMs: 3000, endMs: 3100 });
    });

    it("the switch case: a create waits for the close PATCH in flight", async () => {
      const held = deferred<void>();
      const update = vi.fn(() => held.promise);
      const { queue, ops } = setup({ update });
      queue.edit(row(5, 0, 1000), row(5, 0, 4000), "now");
      queue.create(row(-1, 4000, 4100, 11));
      expect(ops.create).not.toHaveBeenCalled();
      held.resolve();
      await flushPromises();
      expect(ops.create).toHaveBeenCalledTimes(1);
    });

    it("keeps one request in flight per axis, even for different intervals", async () => {
      const held = deferred<void>();
      const update = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue(undefined);
      const { queue } = setup({ update });
      queue.edit(row(5, 0, 1000), row(5, 0, 900), "now");
      queue.edit(row(6, 2000, 3000), row(6, 1500, 3000), "now");
      expect(update).toHaveBeenCalledTimes(1);
      held.resolve();
      await flushPromises();
      expect(update).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenLastCalledWith({ intervalId: 6, startMs: 1500 });
    });

    it("two axes do not block each other", () => {
      const held = deferred<void>();
      const { queue, ops } = setup({ update: vi.fn(() => held.promise) });
      queue.edit(row(5, 0, 1000), row(5, 0, 2000), "now");
      queue.create(other(-1, 0, 100));
      expect(ops.create).toHaveBeenCalledTimes(1);
    });

    it("a create flushes a chain of throttled edits on its axis in order first", async () => {
      vi.useFakeTimers();
      const log: string[] = [];
      const { queue } = setup({
        update: vi.fn(async (v) => {
          log.push(`update ${v.intervalId}`);
        }),
        create: vi.fn(async (v) => {
          log.push("create");
          return { id: 100, ...v };
        }),
      });
      queue.edit(row(5, 0, 1000), row(5, 0, 900), "throttled");
      queue.edit(row(6, 2000, 3000), row(6, 2000, 2900), "throttled");
      queue.edit(row(7, 4000, 5000), row(7, 4000, 4900), "throttled");
      queue.create(row(-1, 6000, 6100, 11));
      await vi.advanceTimersByTimeAsync(0);
      expect(log).toEqual(["update 5", "update 6", "update 7", "create"]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(log).toHaveLength(4);
    });

    it("a create waiting behind a failed edit is still sent", async () => {
      const { queue, ops, onFail } = setup({ update: vi.fn(async () => Promise.reject(new Error("409"))) });
      queue.edit(row(5, 0, 1000), row(5, 0, 2000), "now");
      queue.create(row(-1, 3000, 3100, 11));
      await flushPromises();
      expect(onFail).toHaveBeenCalledWith(5);
      expect(ops.create).toHaveBeenCalledTimes(1);
    });
  });
  describe("error flag", () => {
    it("survives a later successful request of another interval", async () => {
      const other = deferred<void>();
      const update = vi.fn((vars: { intervalId: number }) =>
        vars.intervalId === 5 ? Promise.reject(new Error("409")) : other.promise,
      );
      const { queue } = setup({ update });
      queue.edit({ ...row(6, 0, 1000), categoryId: 3 }, { ...row(6, 0, 2000), categoryId: 3 }, "now");
      queue.edit(row(5, 0, 1000), row(5, 0, 2000), "now");
      await flushPromises();
      expect(queue.state()).toBe("error");
      other.resolve();
      await flushPromises();
      expect(queue.state()).toBe("error");
    });

    it("survives an automatic edit (the growing end following the playhead)", async () => {
      const { queue } = setup({ update: vi.fn().mockRejectedValueOnce(new Error("409")).mockResolvedValue(undefined) });
      queue.edit(row(5, 0, 1000), row(5, 0, 2000), "now");
      await flushPromises();
      expect(queue.state()).toBe("error");
      queue.edit(row(6, 3000, 3100), row(6, 3000, 3500), "throttled", "auto");
      expect(queue.state()).toBe("error");
    });

    it("clears on the next user edit, create or delete", async () => {
      const fail = () => setup({ update: vi.fn().mockRejectedValueOnce(new Error("409")).mockResolvedValue(undefined) });
      for (const act of [
        (q: SaveQueue) => q.edit(row(6, 3000, 3100), row(6, 3000, 3500), "throttled"),
        (q: SaveQueue) => q.create(row(-1, 5000, 5100)),
        (q: SaveQueue) => q.remove(row(7, 6000, 6500)),
      ]) {
        const { queue } = fail();
        queue.edit(row(5, 0, 1000), row(5, 0, 2000), "now");
        await flushPromises();
        expect(queue.state()).toBe("error");
        act(queue);
        expect(queue.state()).not.toBe("error");
      }
    });
  });

  it("drops a deleted interval whose create was never sent, with no request at all", async () => {
    const busy = deferred<void>();
    const { queue, ops } = setup({ update: vi.fn(() => busy.promise) });
    queue.edit(row(5, 0, 1000), row(5, 0, 900), "now");
    queue.create(row(-1, 3000, 3100, 11));
    queue.remove(row(-1, 3000, 3100, 11));
    expect(queue.rows().some((r) => r.row.id === -1)).toBe(false);
    busy.resolve();
    await flushPromises();
    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.remove).not.toHaveBeenCalled();
    expect(queue.state()).toBe("idle");
  });
});

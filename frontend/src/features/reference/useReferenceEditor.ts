import { useEffect, useMemo, useReducer, useRef } from "react";

import {
  type ReferenceRead,
  useCreateInterval,
  useDeleteInterval,
  useUpdateInterval,
} from "../../entities/useReference";
import { isTypingTarget } from "../qc/eventKeys";
import { clampEnd, decideKey, moveEdge } from "./intervals";
import { buildKeymap } from "./keymap";
import { SaveQueue, type SaveState } from "./saveQueue";
import { MIN_INTERVAL_MS, type RefAxis, type RefInterval } from "./types";

const SAVE_THROTTLE_MS = 1000;

export function toRefAxes(reference: ReferenceRead | undefined): RefAxis[] {
  return (reference?.axes ?? []).map((axis) => ({
    categoryId: axis.category_id,
    name: axis.name,
    classes: axis.classes.map((c) => ({ labelId: c.label_id, name: c.name, key: c.key })),
  }));
}

/** The digit of a key press by physical key (any layout), else the character. */
function keyOf(event: KeyboardEvent): string {
  const match = /^(?:Digit|Numpad)(\d)$/.exec(event.code ?? "");
  return match ? match[1] : event.key;
}

interface EditorArgs {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  reference: ReferenceRead | undefined;
  durationMs: number;
}

export interface ReferenceEditor {
  intervals: RefInterval[];
  growing: Record<number, RefInterval | undefined>;
  selectedId: number | null;
  select(id: number | null): void;
  pressClass(categoryId: number, labelId: number): void;
  closeAll(): void;
  deleteSelected(): void;
  dragEdge(id: number, edge: "start" | "end", ms: number): void;
  saveState: SaveState;
}

/** Keyboard and save state machine of the reference editor. Edits show at
 * once; the SaveQueue sends them one request at a time per interval and never
 * before a new interval has its server id. */
export function useReferenceEditor({ videoRef, reference, durationMs }: EditorArgs): ReferenceEditor {
  const videoId = reference?.video_id ?? null;
  const createMutation = useCreateInterval(videoId);
  const updateMutation = useUpdateInterval(videoId);
  const deleteMutation = useDeleteInterval(videoId);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const live = useRef({ reference, durationMs, createMutation, updateMutation, deleteMutation });
  live.current = { reference, durationMs, createMutation, updateMutation, deleteMutation };
  // Growing interval id per category, and the selection; refs so key handlers
  // and queue callbacks always see the newest values.
  const state = useRef({ growing: {} as Record<number, number>, selectedId: null as number | null, localSeq: 0 });

  const queueRef = useRef<SaveQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = new SaveQueue(
      {
        create: async (vars) => {
          const created = await live.current.createMutation.mutateAsync(vars);
          return {
            id: created.id,
            categoryId: created.category_id,
            labelId: created.label_id,
            startMs: created.start_ms,
            endMs: created.end_ms,
          };
        },
        update: (vars) => live.current.updateMutation.mutateAsync(vars),
        remove: (id) => live.current.deleteMutation.mutateAsync(id),
      },
      {
        onRemap: (localId, serverId) => {
          const s = state.current;
          for (const cat of Object.keys(s.growing)) {
            if (s.growing[Number(cat)] === localId) s.growing[Number(cat)] = serverId;
          }
          if (s.selectedId === localId) s.selectedId = serverId;
          bump();
        },
        onFail: (id) => {
          const s = state.current;
          for (const cat of Object.keys(s.growing)) {
            if (s.growing[Number(cat)] === id) delete s.growing[Number(cat)];
          }
          if (s.selectedId === id) s.selectedId = null;
          bump();
        },
        onChange: bump,
      },
      SAVE_THROTTLE_MS,
    );
  }
  const queue = queueRef.current;

  /** Server rows (negative optimistic rows dropped) overlaid by unsaved edits. */
  function currentView(): RefInterval[] {
    const pending = queue.rows();
    const touched = new Set(pending.map((p) => p.row.id));
    const base = (live.current.reference?.intervals ?? [])
      .filter((i) => i.id > 0 && !touched.has(i.id))
      .map((i) => ({ id: i.id, categoryId: i.category_id, labelId: i.label_id, startMs: i.start_ms, endMs: i.end_ms }));
    const edited = pending.filter((p) => !p.deleted).map((p) => p.row);
    return [...base, ...edited].sort((a, b) => a.startMs - b.startMs);
  }

  function growingRows(view: RefInterval[]): Record<number, RefInterval | undefined> {
    const out: Record<number, RefInterval | undefined> = {};
    for (const [cat, id] of Object.entries(state.current.growing)) {
      const row = view.find((iv) => iv.id === id);
      if (row) out[Number(cat)] = row;
    }
    return out;
  }

  function nowMs(): number | null {
    const video = videoRef.current;
    return video ? Math.round(video.currentTime * 1000) : null;
  }

  function close(categoryId: number, endMs: number, view: RefInterval[]) {
    const id = state.current.growing[categoryId];
    delete state.current.growing[categoryId];
    const row = view.find((iv) => iv.id === id);
    if (row) queue.edit(row, { ...row, endMs }, "now");
  }

  function pressClass(categoryId: number, labelId: number) {
    const t = nowMs();
    if (t === null) return;
    const dur = live.current.durationMs;
    const view = currentView();
    const action = decideKey(
      { growing: growingRows(view), selectedId: state.current.selectedId, intervals: view },
      { categoryId, labelId },
      t,
      dur,
    );
    if (action.kind === "close") close(categoryId, action.endMs, view);
    if (action.kind === "switch") close(categoryId, action.closeEndMs, view);
    if (action.kind === "start" || action.kind === "switch") {
      const id = --state.current.localSeq;
      state.current.growing[categoryId] = id;
      queue.create({ id, categoryId, labelId, startMs: action.startMs, endMs: action.startMs + MIN_INTERVAL_MS });
    }
    if (action.kind === "relabel") {
      const row = view.find((iv) => iv.id === action.id);
      if (row) queue.edit(row, { ...row, labelId }, "now");
    }
    bump();
  }

  function closeAll() {
    const t = nowMs();
    const view = currentView();
    for (const [cat, row] of Object.entries(growingRows(view))) {
      if (!row) continue;
      const end = clampEnd(view, row.categoryId, row.id, row.startMs, t ?? row.endMs, live.current.durationMs);
      close(Number(cat), end, view);
    }
    state.current.growing = {};
    bump();
  }

  function deleteSelected() {
    const id = state.current.selectedId;
    if (id === null) return;
    const row = currentView().find((iv) => iv.id === id);
    state.current.selectedId = null;
    for (const cat of Object.keys(state.current.growing)) {
      if (state.current.growing[Number(cat)] === id) delete state.current.growing[Number(cat)];
    }
    if (row) queue.remove(row);
    bump();
  }

  function dragEdge(id: number, edge: "start" | "end", ms: number) {
    const view = currentView();
    // Moving the start of a growing interval ends its growth: the seek would
    // otherwise pull its end back to the new start.
    if (edge === "start") {
      for (const cat of Object.keys(state.current.growing)) {
        if (state.current.growing[Number(cat)] === id) delete state.current.growing[Number(cat)];
      }
    }
    const current = view.find((iv) => iv.id === id);
    const next = moveEdge(view, id, edge, ms, live.current.durationMs);
    if (!current || !next) return;
    const video = videoRef.current;
    if (video) video.currentTime = (edge === "start" ? next.startMs : next.endMs) / 1000;
    queue.edit(current, next, "throttled");
    bump();
  }

  function select(id: number | null) {
    state.current.selectedId = id;
    bump();
  }

  /** The growing ends follow the playhead (throttled saves). */
  function follow() {
    const t = nowMs();
    if (t === null) return;
    const view = currentView();
    for (const row of Object.values(growingRows(view))) {
      if (!row) continue;
      const end = clampEnd(view, row.categoryId, row.id, row.startMs, t, live.current.durationMs);
      if (end !== row.endMs) queue.edit(row, { ...row, endMs: end }, "throttled", "auto");
    }
  }

  const handlers = useRef({ pressClass, closeAll, deleteSelected, follow });
  handlers.current = { pressClass, closeAll, deleteSelected, follow };

  const keymap = useMemo(() => buildKeymap(toRefAxes(reference)), [reference]);
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape") {
        handlers.current.closeAll();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        handlers.current.deleteSelected();
        return;
      }
      const target = keymapRef.current.get(keyOf(event));
      if (!target) return;
      event.preventDefault();
      handlers.current.pressClass(target.categoryId, target.labelId);
    }
    function onPageHide() {
      queue.flushAll();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [queue]);

  useEffect(() => () => queue.dispose(), [queue]);

  const view = currentView();
  const growing = growingRows(view);
  const hasGrowing = Object.keys(growing).length > 0;

  useEffect(() => {
    const video = videoRef.current;
    if (!hasGrowing || !video) return;
    const onTime = () => handlers.current.follow();
    video.addEventListener("timeupdate", onTime);
    let handle = 0;
    const tick = () => {
      handlers.current.follow();
      handle = requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === "function") handle = requestAnimationFrame(tick);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
    };
  }, [hasGrowing, videoRef]);

  return {
    intervals: view,
    growing,
    selectedId: state.current.selectedId,
    select,
    pressClass,
    closeAll,
    deleteSelected,
    dragEdge,
    saveState: queue.state(),
  };
}

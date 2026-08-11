import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAnnotations, useDeleteAnnotation } from "../../entities/useAnnotations";
import { useFrame } from "../../entities/useFrames";
import { useJob } from "../../entities/useJobs";
import { useSequence } from "../../entities/useSequence";
import { useSettings } from "../../entities/useSettings";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import { useSam2Predict, useSam2Track } from "../../entities/useSegmentation";
import { clampTrackRange } from "./clampTrackRange";
import { createFrameEditorStore, type PromptDraft } from "./frameEditorStore";
import { FrameCanvas } from "./FrameCanvas";
import { JobErrorNotice } from "./JobErrorNotice";
import { buildLabelColorMap } from "./labelColors";
import { ToolsPanel } from "./ToolsPanel";
import type { components } from "../../shared/api/generated/schema";

type FrameRead = components["schemas"]["FrameRead"];
type JobRead = components["schemas"]["JobRead"];

interface FrameEditorProps {
  frameId: number;
  frames: FrameRead[];
  onClose: () => void;
  onFrameChange: (frameId: number) => void;
}

export type JobBanner = { kind: "progress"; progress: number } | { kind: "error"; message: string };

export function describeJobBanner(job: Pick<JobRead, "status" | "progress" | "error"> | undefined): JobBanner | null {
  if (!job) return null;
  if (job.status === "pending" || job.status === "running") {
    return { kind: "progress", progress: job.progress };
  }
  if (job.status === "failed") {
    return { kind: "error", message: job.error ?? "The job failed." };
  }
  return null;
}

export function FrameEditor({ frameId, frames, onClose, onFrameChange }: FrameEditorProps) {
  // Created once per FrameEditor mount (not per frameId) so the Label
  // selection survives navigating between frames within the same editing
  // session -- FrameEditor unmounts back to the sequence grid between
  // sessions, which is what actually resets it. Per-frame state (pending
  // prompts, draft/selected/hovered annotation) is cleared explicitly by
  // the frameId effect below instead.
  const store = useMemo(() => createFrameEditorStore(), []);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [dismissedJobId, setDismissedJobId] = useState<number | null>(null);
  const [lastKnownVram, setLastKnownVram] = useState<{ used: number; total: number } | null>(null);
  const [frameInputValue, setFrameInputValue] = useState("");
  const queryClient = useQueryClient();

  const frameQuery = useFrame(frameId);
  const annotationsQuery = useAnnotations(frameId);
  const jobQuery = useJob(activeJobId);

  useEffect(() => {
    const used = jobQuery.data?.vram_used_bytes;
    const total = jobQuery.data?.vram_total_bytes;
    if (used !== null && used !== undefined && total !== null && total !== undefined) {
      setLastKnownVram({ used, total });
    }
  }, [jobQuery.data?.vram_used_bytes, jobQuery.data?.vram_total_bytes]);
  const sequenceQuery = useSequence(frameQuery.data?.sequence_id ?? Number.NaN);
  const taxonomyTreeQuery = useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null);
  const predictMutation = useSam2Predict();
  const trackMutation = useSam2Track();
  const deleteAnnotation = useDeleteAnnotation(frameId);
  const settingsQuery = useSettings();

  const labelColorById = useMemo(() => buildLabelColorMap(taxonomyTreeQuery.data ?? []), [taxonomyTreeQuery.data]);

  const orderedFrames = [...frames].sort((a, b) => a.frame_index - b.frame_index);
  const currentIndex = orderedFrames.findIndex((f) => f.id === frameId);
  const prevFrame = currentIndex > 0 ? orderedFrames[currentIndex - 1] : null;
  const nextFrame = currentIndex >= 0 && currentIndex < orderedFrames.length - 1 ? orderedFrames[currentIndex + 1] : null;
  // How many frames exist behind/ahead of the current one within this
  // sequence -- backs both the Track "Max" shortcut buttons and the
  // forward-defaults-to-rest-of-sequence behavior below. -1 (all frames
  // behind/ahead) only while frames/currentIndex haven't loaded yet.
  const maxBackward = currentIndex >= 0 ? currentIndex : 0;
  const maxForward = currentIndex >= 0 ? orderedFrames.length - 1 - currentIndex : 0;

  useEffect(() => {
    setFrameInputValue(String(currentIndex + 1));
  }, [currentIndex]);

  // Per-frame state doesn't belong to the session-scoped store above: old
  // points/boxes/masks and the selected/hovered annotation refer to the
  // frame just left, and Forward's "track to the end of the sequence"
  // default depends on this frame's position, not the previous one's. The
  // label choice (Category/Classification/Tag) and Backward are
  // deliberately left untouched by resetForNewFrame -- see the store.
  useEffect(() => {
    store.getState().resetForNewFrame();
    // Forward defaults to "the rest of the sequence" on every frame change
    // (ignoring whatever it was on the frame just left); Backward keeps
    // whatever the user last set, but both are re-clamped together against
    // the new frame's per-sequence bounds and the combined GPU-safety cap
    // from Settings (see docs/superpowers/specs/2026-08-11-settings-page-design.md)
    // -- otherwise a Backward set on a frame with more room behind it would
    // stay past the new frame's start, and a sequence with more frames
    // ahead than the cap would default Forward above it.
    const combinedCap = settingsQuery.data?.max_track_range_frames ?? Infinity;
    const currentBackward = store.getState().backward;
    const next = clampTrackRange(
      { backward: currentBackward, forward: maxForward },
      { maxBackward, maxForward, combinedCap },
    );
    store.getState().setBackward(next.backward);
    store.getState().setForward(next.forward);
    // maxBackward and maxForward intentionally excluded: they're pure
    // functions of frameId (via currentIndex) here, so including them
    // would double-fire this effect on every render where they're
    // recomputed as the same value. settingsQuery.data is also excluded
    // -- this effect only needs to run once per frame change; the
    // separate effect below re-clamps against the cap once it resolves,
    // so this one doesn't need to duplicate that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameId, store]);

  // The settings query resolves asynchronously, generally after the
  // above effect has already set Forward to the frame's full per-sequence
  // bound (uncapped, since settingsQuery.data is undefined on that first
  // run). Without this, Forward/Backward would display an uncapped value
  // indefinitely until the user happens to change frames -- misleading,
  // even though handleTrack's own re-clamp before sending keeps the
  // actual request safe regardless. Re-clamping here as soon as the cap
  // is known (or changes) keeps what's displayed honest too.
  useEffect(() => {
    if (settingsQuery.data === undefined) return;
    const state = store.getState();
    const next = clampTrackRange(
      { backward: state.backward, forward: state.forward },
      { maxBackward, maxForward, combinedCap: settingsQuery.data.max_track_range_frames },
    );
    if (next.backward !== state.backward) store.getState().setBackward(next.backward);
    if (next.forward !== state.forward) store.getState().setForward(next.forward);
  }, [settingsQuery.data, maxBackward, maxForward, store]);

  useEffect(() => {
    if (jobQuery.data?.status === "succeeded") {
      queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
    }
  }, [jobQuery.data?.status, jobQuery.data?.id, frameId, queryClient]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "SELECT" || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (event.key === "ArrowLeft" && prevFrame) onFrameChange(prevFrame.id);
      if (event.key === "ArrowRight" && nextFrame) onFrameChange(nextFrame.id);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevFrame, nextFrame, onFrameChange]);

  // Re-predicts using the FULL accumulated prompt set for the in-progress
  // object and replaces the previous draft mask (if any) with the new one,
  // so refining one object via several point/box gestures never leaves a
  // trail of stale draft Annotation rows behind -- only the latest guess
  // for the object being worked on exists at any time. Does NOT clear
  // pendingPrompts: the object stays in progress until Track/Generate from
  // mask explicitly finishes it.
  function refinePredict(prompts: PromptDraft[]) {
    const state = store.getState();
    if (state.labelTagId === null) return;
    const previousDraftId = state.draftAnnotationId;

    // The last remaining refinement point was just removed -- nothing left
    // to predict from, so just drop the now-orphaned draft mask instead of
    // firing a predict call with an empty prompt list.
    if (prompts.length === 0) {
      if (previousDraftId !== null) {
        deleteAnnotation.mutate(previousDraftId);
        store.getState().setDraftAnnotationId(null);
      }
      return;
    }

    predictMutation.mutate(
      {
        frame_id: frameId,
        label_id: state.labelTagId,
        prompts,
        mask_postprocess_strength: state.maskSmoothingStrength,
      },
      {
        onSuccess: (data) => {
          if (!data) return;
          setActiveJobId(data.id);
          if (previousDraftId !== null) {
            deleteAnnotation.mutate(previousDraftId);
          }
        },
      },
    );
  }

  // A predict job's new Annotation becomes the current draft once the job
  // succeeds -- recorded here (not at submit time) since the Annotation id
  // isn't known until the job result is read back and annotations refetch.
  useEffect(() => {
    if (jobQuery.data?.status === "succeeded" && jobQuery.data.job_type === "sam2_predict") {
      const created = annotationsQuery.data?.find((a) => a.job_id === jobQuery.data?.id);
      if (created) store.getState().setDraftAnnotationId(created.id);
    }
  }, [jobQuery.data?.status, jobQuery.data?.id, jobQuery.data?.job_type, annotationsQuery.data, store]);

  function handlePointOrBoxSubmit(prompts: PromptDraft[]) {
    refinePredict(prompts);
  }

  // Deleting the mask that's currently being refined (the draft) must also
  // drop its accumulated point/box markers -- otherwise the points stay on
  // screen pointing at a mask that no longer exists.
  function handleRemoveAnnotation(annotationId: number) {
    deleteAnnotation.mutate(annotationId);
    if (store.getState().draftAnnotationId === annotationId) {
      store.getState().clearPrompts();
    }
  }

  function handleTrack() {
    const state = store.getState();
    if (state.labelTagId === null || state.pendingPrompts.length === 0) return;
    // Re-clamp right before sending, not just trust the store's current
    // value -- TrackControls clamps as the user edits, but if the settings
    // query resolves to a lower cap (or its default changes) between the
    // user's last edit and clicking Track, the stored value could still be
    // stale. This guarantees the request itself is always valid, matching
    // what the backend's own live check in enqueue_sam2_track enforces.
    const combinedCap = settingsQuery.data?.max_track_range_frames ?? Infinity;
    const { backward, forward } = clampTrackRange(
      { backward: state.backward, forward: state.forward },
      { maxBackward, maxForward, combinedCap },
    );
    trackMutation.mutate(
      {
        sequence_id: frameQuery.data?.sequence_id ?? 0,
        label_id: state.labelTagId,
        prompts: state.pendingPrompts,
        anchor_frame_id: frameId,
        backward,
        forward,
        mask_postprocess_strength: state.maskSmoothingStrength,
      },
      {
        onSuccess: (data) => {
          if (data) setActiveJobId(data.id);
          const draftId = store.getState().draftAnnotationId;
          if (draftId !== null) deleteAnnotation.mutate(draftId);
          store.getState().clearPrompts();
        },
      },
    );
  }

  function commitFrameInput() {
    const parsed = Number(frameInputValue);
    if (!Number.isFinite(parsed)) {
      setFrameInputValue(String(currentIndex + 1));
      return;
    }
    const clamped = Math.min(Math.max(Math.trunc(parsed), 1), orderedFrames.length);
    const target = orderedFrames[clamped - 1];
    if (target) onFrameChange(target.id);
  }

  const vramIsLive = jobQuery.data?.status === "pending" || jobQuery.data?.status === "running";

  if (!frameQuery.data) {
    return <p className="p-8 text-sm text-gray-500">Loading frame...</p>;
  }

  return (
    <div className="flex h-full flex-col bg-gray-950 text-gray-100">
      {(() => {
        const banner = describeJobBanner(jobQuery.data);
        if (banner?.kind === "error" && jobQuery.data?.id !== dismissedJobId) {
          return (
            <JobErrorNotice
              message={banner.message}
              onDismiss={() => setDismissedJobId(jobQuery.data?.id ?? null)}
            />
          );
        }
        return null;
      })()}
      <div className="flex items-center gap-3 border-b border-gray-800 p-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-gray-700 px-3 py-1 text-sm text-gray-200 hover:bg-gray-800"
        >
          ✕ Back to grid
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Prev frame"
            disabled={!prevFrame}
            onClick={() => prevFrame && onFrameChange(prevFrame.id)}
            className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹ Prev
          </button>
          <label className="flex items-center gap-1 text-sm text-gray-400">
            Frame
            <input
              aria-label="Frame number"
              type="number"
              min={1}
              max={orderedFrames.length}
              value={frameInputValue}
              onChange={(event) => setFrameInputValue(event.target.value)}
              onBlur={commitFrameInput}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitFrameInput();
                }
              }}
              className="w-14 rounded border border-gray-700 bg-gray-900 px-1 py-0.5 text-center text-sm text-gray-100"
            />
            of {orderedFrames.length}
          </label>
          <button
            type="button"
            aria-label="Next frame"
            disabled={!nextFrame}
            onClick={() => nextFrame && onFrameChange(nextFrame.id)}
            className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next ›
          </button>
        </div>
        {jobQuery.data?.id !== dismissedJobId
          ? (() => {
              const banner = describeJobBanner(jobQuery.data);
              if (!banner || banner.kind !== "progress") return null;
              return (
                <span role="status" aria-label="Job in progress" className="ml-3 flex items-center gap-2 text-sm text-gray-400">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
                  {jobQuery.data?.status} ({banner.progress}%)
                </span>
              );
            })()
          : null}
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 flex-1 overflow-hidden p-4">
          <div
            className="absolute inset-4 m-auto"
            style={{
              aspectRatio: `${frameQuery.data.width} / ${frameQuery.data.height}`,
              maxWidth: "100%",
              maxHeight: "100%",
            }}
          >
            <FrameCanvas
              frame={frameQuery.data}
              annotations={annotationsQuery.data ?? []}
              store={store}
              onPointOrBoxSubmit={handlePointOrBoxSubmit}
              onRemoveAnnotation={handleRemoveAnnotation}
              labelColorById={labelColorById}
            />
          </div>
        </div>
        <ToolsPanel
          store={store}
          annotations={annotationsQuery.data ?? []}
          frameId={frameId}
          onTrack={handleTrack}
          procedureId={sequenceQuery.data?.procedure_id ?? null}
          vramUsedBytes={lastKnownVram?.used ?? null}
          vramTotalBytes={lastKnownVram?.total ?? null}
          vramIsLive={vramIsLive}
          maxBackward={maxBackward}
          maxForward={maxForward}
        />
      </div>
    </div>
  );
}

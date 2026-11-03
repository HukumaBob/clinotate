import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";

import { useReference, useRestoreClean } from "../../../entities/useReference";
import { matchAxes } from "../../reference/matchAxes";
import { ReferenceKeys } from "../../reference/ReferenceKeys";
import { ReferenceLanes } from "../../reference/ReferenceLanes";
import { ReferenceStatus } from "../../reference/ReferenceStatus";
import { toRefAxes, useReferenceEditor } from "../../reference/useReferenceEditor";
import type { ClassificationDocument } from "./types";

interface RunReferenceArgs {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoId: number | null;
  /** The model's axes; undefined until the predictions load. */
  modelAxes: ClassificationDocument["axes"] | undefined;
  /** The run page's time scale, shared with the model lanes. */
  durationMs: number;
}

export interface RunReference {
  /** Above the video: the compromised warning, or nothing. */
  banner: ReactNode;
  /** Above the lanes: the key legend, status and the "Label reference" link. */
  bar: ReactNode;
  /** Per model axis, its editable reference lane (null: no matching axis);
   * undefined while the reference is loading or could not be loaded. */
  lanes: (ReactNode | null)[] | undefined;
}

/** The video's reference on the classification run page: each model axis is
 * matched to a reference axis by class names, and the matched axes are
 * editable from the keyboard as on the reference page. Axes that match no
 * model axis are neither shown nor editable here. */
export function useRunReference({ videoRef, videoId, modelAxes, durationMs }: RunReferenceArgs): RunReference {
  const query = useReference(videoId);
  const restore = useRestoreClean(videoId);
  const reference = query.data;

  const refAxes = useMemo(() => toRefAxes(reference), [reference]);
  const matches = useMemo(
    () => (modelAxes && refAxes.length > 0 ? matchAxes(modelAxes, refAxes) : []),
    [modelAxes, refAxes],
  );
  const matchedKey = [...new Set(matches.filter((m): m is number => m !== null))].sort((a, b) => a - b).join(",");
  const matchedIndexes = useMemo(
    () => (matchedKey === "" ? [] : matchedKey.split(",").map(Number)),
    [matchedKey],
  );

  // The editor only knows the matched axes, so the keys of an axis not shown
  // on this page do nothing.
  const editorReference = useMemo(
    () => reference && { ...reference, axes: reference.axes.filter((_, i) => matchedIndexes.includes(i)) },
    [reference, matchedIndexes],
  );
  const editor = useReferenceEditor({
    videoRef,
    reference: editorReference,
    durationMs: reference?.duration_ms || durationMs,
  });

  if (!reference) return { banner: null, bar: null, lanes: undefined };

  const matchedAxes = matchedIndexes.map((i) => refAxes[i]);
  const matchedCategories = new Set(matchedAxes.map((axis) => axis.categoryId));
  const orphanedCount = reference.intervals.filter(
    (interval) => interval.orphaned && matchedCategories.has(interval.category_id),
  ).length;

  const banner =
    reference.status === "compromised" ? (
      <p className="rounded border border-amber-700 bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
        This video&apos;s reference is no longer an unbiased test: frames of it were used for training
      </p>
    ) : null;

  const showLink = reference.status === "none" || matchedAxes.length === 0;
  const bar = (
    <div className="flex flex-col gap-2">
      {matchedAxes.length > 0 && <ReferenceKeys axes={matchedAxes} onPress={editor.pressClass} />}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {matchedAxes.length > 0 && (
          <ReferenceStatus
            status={reference.status}
            compromisedAt={reference.compromised_at}
            onRestore={() => restore.mutate()}
          />
        )}
        {editor.saveState === "saving" && <span className="text-xs text-gray-400">Saving…</span>}
        {editor.saveState === "error" && (
          <span role="alert" className="text-xs text-red-400">
            Not saved: changes will be retried on your next edit
          </span>
        )}
        {orphanedCount > 0 && (
          <span className="text-xs text-amber-400">
            {`${orphanedCount} orphaned reference ${orphanedCount === 1 ? "interval" : "intervals"}`}
          </span>
        )}
        {showLink && videoId !== null && (
          <Link to={`/qc/reference/${videoId}`} className="text-xs text-blue-400 hover:underline">
            Label reference
          </Link>
        )}
      </div>
    </div>
  );

  const lanes = matches.map((m) =>
    m === null ? null : (
      <ReferenceLanes
        videoRef={videoRef}
        axes={[refAxes[m]]}
        intervals={editor.intervals}
        growing={editor.growing}
        selectedId={editor.selectedId}
        durationMs={durationMs}
        onSelect={editor.select}
        onDragEdge={editor.dragEdge}
        orphanedCount={0}
      />
    ),
  );

  return { banner, bar, lanes };
}

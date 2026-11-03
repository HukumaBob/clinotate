import { type ReactNode, useCallback, useMemo, useState } from "react";

import { useEvaluation } from "../../../entities/useEvaluation";
import type { AxisIndex } from "./axisIndex";
import type { ErrorSpan } from "./AxisLanes";
import { EvaluationPanel, type ReferenceState } from "./EvaluationPanel";
import { episodeSpans, processedStepMs } from "./evaluationLogic";
import type { ClassificationDocument } from "./types";

/** The tolerance the page and the panel start with, as the endpoint's default. */
const DEFAULT_BOUNDARY_MS = 2000;

interface RunEvaluationArgs {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  runId: number | null;
  videoId: number | null;
  /** Whether the video's reference has loaded: nothing is requested until it has. */
  referenceState: ReferenceState;
  /** The loaded reference has at least one labeled interval: nothing is
   * requested otherwise. */
  hasReference: boolean;
  /** The model's axes; undefined until the predictions load. */
  modelAxes: ClassificationDocument["axes"] | undefined;
  indexes: AxisIndex[];
  /** The page's manual seek (drops the blip highlight). */
  seekTo: (ms: number) => void;
}

export interface RunEvaluation {
  /** The sidebar panel; null until the run and its video are known. */
  panel: ReactNode;
  /** Per model axis, its error episodes as lane spans; undefined while there
   * is no evaluation. Stable between renders while the response is. */
  errorSpans: ErrorSpan[][] | undefined;
}

/** The run's evaluation against the video's reference: the panel, and the
 * error episodes of each model axis for the red hatching on its lane. The
 * panel asks for the same query (same key) as this hook, so the request is
 * made once. */
export function useRunEvaluation({
  videoRef,
  runId,
  videoId,
  referenceState,
  hasReference,
  modelAxes,
  indexes,
  seekTo,
}: RunEvaluationArgs): RunEvaluation {
  const [boundaryMs, setBoundaryMs] = useState(DEFAULT_BOUNDARY_MS);
  const scoring = referenceState === "ready" && hasReference;
  const query = useEvaluation(runId, boundaryMs, scoring);
  const evaluation = scoring ? query.data : undefined;

  const errorSpans = useMemo(() => {
    if (!evaluation || !modelAxes) return undefined;
    const stepMs = processedStepMs(indexes[0]?.timestamps ?? []);
    return modelAxes.map((axis, i) => {
      // The response lists the axes in the document's order; the name guards it.
      const scored =
        evaluation.axes[i]?.name === axis.name
          ? evaluation.axes[i]
          : evaluation.axes.find((candidate) => candidate.name === axis.name);
      return scored && scored.matched ? episodeSpans(scored.episodes, stepMs) : [];
    });
  }, [evaluation, modelAxes, indexes]);

  // An episode click stops playback on the error, then seeks as a lane click does.
  const seekPaused = useCallback(
    (ms: number) => {
      videoRef.current?.pause();
      seekTo(ms);
    },
    [videoRef, seekTo],
  );

  const panel =
    runId !== null && videoId !== null ? (
      <EvaluationPanel
        runId={runId}
        videoId={videoId}
        referenceState={referenceState}
        hasReference={hasReference}
        onSeek={seekPaused}
        onBoundaryChange={setBoundaryMs}
        initialBoundaryMs={DEFAULT_BOUNDARY_MS}
      />
    ) : null;

  return { panel, errorSpans };
}

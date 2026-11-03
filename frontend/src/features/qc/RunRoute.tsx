import { useParams } from "react-router-dom";

import { useInferenceRun } from "../../entities/useInferenceRuns";
import { ClassificationRunPage } from "./classification/ClassificationRunPage";
import { RunViewPage } from "./RunViewPage";

/** `/qc/:runId`: a run with axes is a classification run and gets its own
 * page; everything else (including a run that failed to load, whose error
 * the detection page shows) goes to the detection page. */
export function RunRoute() {
  const params = useParams();
  const runId = params.runId ? Number(params.runId) : null;
  const runQuery = useInferenceRun(runId);

  if (runQuery.isPending && runId !== null) {
    return <p className="p-6 text-sm text-gray-500">Loading run…</p>;
  }
  // Keyed by video: a run of another video gets a fresh reference editor.
  if (runQuery.data?.axes) return <ClassificationRunPage key={runQuery.data.video_id} />;
  return <RunViewPage />;
}

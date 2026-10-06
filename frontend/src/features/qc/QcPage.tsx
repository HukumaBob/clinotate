import { useState } from "react";

import {
  useCreateInferenceRun,
  useDeleteInferenceRun,
  useInferenceRuns,
} from "../../entities/useInferenceRuns";
import { useModelVersions } from "../../entities/useModelVersions";
import { useVideos } from "../../entities/useVideos";
import { VideoUploadFlow } from "../media/VideoUploadFlow";
import { errorMessage } from "./errorMessage";
import { RunForm } from "./RunForm";
import { RunStatus } from "./RunStatus";
import { RunsTable } from "./RunsTable";

// Only the model types the worker can run; classification is a later slice.
const RUNNABLE = new Set(["detection", "segmentation"]);

export function QcPage() {
  const runsQuery = useInferenceRuns();
  const modelsQuery = useModelVersions();
  const videosQuery = useVideos();
  const createRun = useCreateInferenceRun();
  const deleteRun = useDeleteInferenceRun();

  const [videoId, setVideoId] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const runs = runsQuery.data ?? [];
  const videos = videosQuery.data ?? [];
  const models = (modelsQuery.data ?? []).filter((m) => RUNNABLE.has(m.task_type));
  const videoTitles = Object.fromEntries(videos.map((v) => [v.id, v.title]));
  const shownRun =
    runs.find((run) => run.id === selectedRunId) ??
    runs.find((run) => run.status === "pending" || run.status === "running") ??
    runs[0] ??
    null;

  const submitError = createRun.error ? errorMessage(createRun.error, "Could not start the run") : null;

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-gray-100">QC</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <RunForm
            models={models}
            videos={videos}
            videoId={videoId}
            onVideoChange={setVideoId}
            submitting={createRun.isPending}
            error={submitError}
            onSubmit={({ modelVersionId, videoId: vid, frameStride }) =>
              createRun.mutate(
                { model_version_id: modelVersionId, video_id: vid, frame_stride: frameStride },
                { onSuccess: (run) => run && setSelectedRunId(run.id) },
              )
            }
          />
          <button
            type="button"
            onClick={() => setShowUpload((open) => !open)}
            className="self-start text-sm text-blue-400 hover:underline"
          >
            {showUpload ? "Hide upload" : "Upload a new video"}
          </button>
          {showUpload && (
            <VideoUploadFlow
              onVideoUploaded={(id) => {
                setVideoId(id);
                setShowUpload(false);
              }}
            />
          )}
        </div>
        <RunStatus run={shownRun} />
      </div>
      {deleteRun.error && (
        <p role="alert" className="text-sm text-red-400">
          {errorMessage(deleteRun.error, "Could not delete the run")}
        </p>
      )}
      <RunsTable
        runs={runs}
        videoTitles={videoTitles}
        onDelete={(id, force) => deleteRun.mutate({ runId: id, force })}
      />
    </div>
  );
}

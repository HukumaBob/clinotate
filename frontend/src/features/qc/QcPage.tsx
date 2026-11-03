import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  useCreateInferenceRun,
  useDeleteInferenceRun,
  useInferenceRuns,
} from "../../entities/useInferenceRuns";
import { useModelVersions } from "../../entities/useModelVersions";
import { useVideos } from "../../entities/useVideos";
import { VideoUploadFlow } from "../media/VideoUploadFlow";
import { comparability } from "./compareLogic";
import { errorMessage } from "./errorMessage";
import { classificationModels, runnableModels } from "./runnableModels";
import { RunForm } from "./RunForm";
import { RunStatus } from "./RunStatus";
import { RunsTable } from "./RunsTable";

export function QcPage() {
  const runsQuery = useInferenceRuns();
  const modelsQuery = useModelVersions();
  const videosQuery = useVideos();
  const createRun = useCreateInferenceRun();
  const deleteRun = useDeleteInferenceRun();

  const [videoId, setVideoId] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const navigate = useNavigate();

  const runs = runsQuery.data ?? [];
  const videos = videosQuery.data ?? [];
  const models = runnableModels(modelsQuery.data ?? []);
  const classifyModels = classificationModels(modelsQuery.data ?? []);
  const videoTitles = Object.fromEntries(videos.map((v) => [v.id, v.title]));
  const shownRun =
    runs.find((run) => run.id === selectedRunId) ??
    runs.find((run) => run.status === "pending" || run.status === "running") ??
    runs[0] ??
    null;

  // At most two picks: a third drops the oldest.
  const toggleSelect = (id: number) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id].slice(-2),
    );
  const verdict = comparability(
    runs.find((run) => run.id === selected[0]),
    runs.find((run) => run.id === selected[1]),
  );

  const submitError = createRun.error
    ? errorMessage(createRun.error, "Could not start the run")
    : null;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <RunForm
            models={models}
            classifyModels={classifyModels}
            videos={videos}
            videoId={videoId}
            onVideoChange={setVideoId}
            submitting={createRun.isPending}
            error={submitError}
            onSubmit={(values) => {
              const common = {
                video_id: values.videoId,
                frame_stride: values.frameStride,
                perturbation: values.perturbation,
                ...(values.crop ? { crop: values.crop } : {}),
              };
              const body =
                "classifiers" in values
                  ? {
                      ...common,
                      classifiers: values.classifiers.map((c) => ({
                        model_version_id: c.modelVersionId,
                        ...(c.name ? { name: c.name } : {}),
                      })),
                    }
                  : { ...common, model_version_id: values.modelVersionId };
              createRun.mutate(body, {
                onSuccess: (run) => run && setSelectedRunId(run.id),
              });
            }}
          />
          {videoId !== null && (
            <Link to={`/qc/reference/${videoId}`} className="self-start text-sm text-blue-400 hover:underline">
              Label reference
            </Link>
          )}
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
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!verdict.ok}
          title={verdict.ok ? undefined : verdict.reason}
          onClick={() => navigate(`/qc/compare/${selected[0]}/${selected[1]}`)}
          className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:text-white disabled:opacity-50"
        >
          Compare
        </button>
        {selected.length === 2 && !verdict.ok && (
          <span className="text-xs text-gray-500">{verdict.reason}</span>
        )}
      </div>
      <RunsTable
        runs={runs}
        videoTitles={videoTitles}
        onDelete={(id, force) => deleteRun.mutate({ runId: id, force })}
        selected={selected}
        onToggleSelect={toggleSelect}
      />
    </div>
  );
}

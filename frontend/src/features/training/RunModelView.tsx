import { SECTION_HEADING } from "./ui";
import { useEffect, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { ArtifactGallery } from "./ArtifactGallery";
import { headlineScore } from "./runLogic";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];
type ModelVersionRead = components["schemas"]["ModelVersionRead"];
type ArtifactRead = components["schemas"]["ArtifactRead"];

interface RunModelViewProps {
  run: TrainingRunRead;
  onChanged: () => void;
}

export function RunModelView({ run, onChanged }: RunModelViewProps) {
  const versionId = run.model_version_id;
  const [version, setVersion] = useState<ModelVersionRead | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRead[]>([]);
  const [failed, setFailed] = useState(false);
  const [armed, setArmed] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setVersion(null);
    setArtifacts([]);
    setFailed(false);
    setArmed(false);
    setDeleteError(null);
    if (versionId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const [models, metrics] = await Promise.all([
          apiClient.GET("/training/models", {}),
          apiClient.GET("/training/models/{version_id}/metrics", {
            params: { path: { version_id: versionId } },
          }),
        ]);
        if (cancelled) return;
        const found = (models.data ?? []).find((item) => item.id === versionId) ?? null;
        if (!found || metrics.error) setFailed(true);
        setVersion(found);
        setArtifacts(metrics.data?.artifacts ?? []);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  if (versionId == null) {
    return (
      <p className="text-sm text-gray-400">
        This run has no model (it failed, was stopped before the first epoch, or its model was deleted)
      </p>
    );
  }
  if (!version) {
    return (
      <p className="text-sm text-gray-400">{failed ? "Failed to load the model." : "Loading…"}</p>
    );
  }

  const score = headlineScore(version.task_type, version.metrics as Record<string, unknown>);

  async function download() {
    try {
      const { data } = await apiClient.GET("/training/models/{version_id}/download", {
        params: { path: { version_id: versionId as number } },
      });
      if (data?.download_url) {
        setDeleteError(null);
        window.open(data.download_url, "_blank", "noopener,noreferrer");
      } else {
        setDeleteError("Failed to get the download link.");
      }
    } catch {
      setDeleteError("Failed to get the download link.");
    }
  }

  async function remove() {
    setArmed(false);
    try {
      const { error } = await apiClient.DELETE("/training/models/{version_id}", {
        params: { path: { version_id: versionId as number } },
      });
      if (error) {
        setDeleteError((error as { detail?: string }).detail ?? "Failed to delete the model.");
        return;
      }
      setDeleteError(null);
      onChanged();
    } catch {
      setDeleteError("Failed to delete the model.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-100">{version.name}</h3>
            <p className="text-xs text-gray-400">
              {version.task_type} · {score.value} <span className="text-gray-400">{score.label}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={`Download model ${version.name}`}
              onClick={() => void download()}
              className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
            >
              Download
            </button>
            {armed ? (
              <button
                type="button"
                aria-label={`Confirm delete model ${version.name}`}
                onClick={() => void remove()}
                className="rounded bg-red-700 px-2 py-1 text-xs text-white"
              >
                Confirm
              </button>
            ) : (
              <button
                type="button"
                aria-label={`Delete model ${version.name}`}
                onClick={() => setArmed(true)}
                className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300"
              >
                Delete model
              </button>
            )}
          </div>
        </div>
        {deleteError && (
          <p role="alert" className="mt-3 text-sm text-red-400">
            {deleteError}
          </p>
        )}
      </section>

      {failed && (
        <p className="text-sm text-gray-400">Failed to load the model's artifacts.</p>
      )}

      {artifacts.length > 0 && (
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <h3 className={`mb-2 ${SECTION_HEADING}`}>Artifacts</h3>
          <ArtifactGallery versionId={versionId} artifacts={artifacts} />
        </section>
      )}
    </div>
  );
}

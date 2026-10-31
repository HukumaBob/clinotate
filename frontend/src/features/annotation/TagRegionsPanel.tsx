import { useEffect, useMemo, useState } from "react";

import {
  useRegionLabels,
  useRemoveCopiesPreview,
  useRemoveRegionCopies,
  useTagRegions,
  useTagRegionsPreview,
  type RemoveCopiesParams,
  type TagRegionsParams,
} from "../../entities/useAnnotations";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

type Mode = "create" | "remove";

interface TagRegionsPanelProps {
  sequenceId: number;
  frameIds: number[];
  taxonomyTree: TaxonomyTreeNode[];
  onClose: () => void;
}

const selectClassName =
  "w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200 disabled:opacity-40";

function parseId(rawValue: string): number | null {
  const parsed = Number(rawValue);
  return rawValue !== "" && Number.isFinite(parsed) ? parsed : null;
}

export function TagRegionsPanel({ sequenceId, frameIds, taxonomyTree, onClose }: TagRegionsPanelProps) {
  const [mode, setMode] = useState<Mode>("create");
  const [sourceLabelId, setSourceLabelId] = useState<number | null>(null);
  const [targetCategoryId, setTargetCategoryId] = useState<number | null>(null);
  const [targetLabelId, setTargetLabelId] = useState<number | null>(null);
  const [skipManualFrames, setSkipManualFrames] = useState(true);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function clearOutcome() {
    setResultMessage(null);
    setActionError(null);
  }

  const frameKey = frameIds.join(",");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Any change to what Remove would act on disarms the confirm step.
  useEffect(() => {
    setRemoveArmed(false);
  }, [mode, targetLabelId, frameKey]);

  const regionLabelsQuery = useRegionLabels(frameIds, true);
  const sourceLabels = regionLabelsQuery.data ?? [];

  // Same Category -> Label cascade as the toolbar's classification pickers,
  // but over region-scoped evaluation types.
  const targetCategories = useMemo(
    () =>
      taxonomyTree
        .map((node) => ({
          category: node.category,
          labels: node.evaluation_types
            .filter((entry) => entry.evaluation_type.annotation_scope === "region")
            .flatMap((entry) => entry.labels)
            .filter((label) => !label.is_abstract),
        }))
        .filter((entry) => entry.labels.length > 0),
    [taxonomyTree],
  );
  const targetLabels = targetCategories.find((entry) => entry.category.id === targetCategoryId)?.labels ?? [];

  const tagParams = useMemo<TagRegionsParams | null>(
    () =>
      mode === "create" && sourceLabelId !== null && targetLabelId !== null
        ? { frameIds, sourceLabelId, targetLabelId, skipManualFrames }
        : null,
    // frameKey stands in for frameIds' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, frameKey, sourceLabelId, targetLabelId, skipManualFrames],
  );
  const removeParams = useMemo<RemoveCopiesParams | null>(
    () => (mode === "remove" && targetLabelId !== null ? { frameIds, targetLabelId } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, frameKey, targetLabelId],
  );

  const tagPreview = useTagRegionsPreview(tagParams);
  const removePreview = useRemoveCopiesPreview(removeParams);
  const tagRegions = useTagRegions(sequenceId);
  const removeCopies = useRemoveRegionCopies(sequenceId);

  const createCount = tagPreview.data?.regions ?? 0;
  const removeCount = removePreview.data?.removed ?? 0;
  const createDisabled =
    tagParams === null || createCount === 0 || tagPreview.isFetching || tagPreview.isError || tagRegions.isPending;
  const removeDisabled =
    removeParams === null ||
    removeCount === 0 ||
    removePreview.isFetching ||
    removePreview.isError ||
    removeCopies.isPending;

  function handleModeChange(nextMode: Mode) {
    setMode(nextMode);
    clearOutcome();
  }

  function handleTargetCategoryChange(rawValue: string) {
    setTargetCategoryId(parseId(rawValue));
    setTargetLabelId(null);
    clearOutcome();
  }

  function handleCreate() {
    if (tagParams === null) return;
    clearOutcome();
    tagRegions.mutate(tagParams, {
      onSuccess: (data) => setResultMessage(`Created ${data.regions} regions on ${data.frames} frames.`),
      onError: (error) => setActionError(error.message),
    });
  }

  function handleRemove() {
    if (removeParams === null) return;
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }
    setRemoveArmed(false);
    clearOutcome();
    removeCopies.mutate(removeParams, {
      onSuccess: (data) => setResultMessage(`Removed ${data.removed} copies.`),
      onError: (error) => setActionError(error.message),
    });
  }

  const modeButtonClass = (active: boolean) =>
    `rounded px-3 py-1 text-sm ${active ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-200"}`;

  const previewError = mode === "create" ? tagPreview.error : removePreview.error;

  return (
    <div className="w-96 space-y-3 rounded border border-gray-700 bg-gray-900 p-4 text-sm text-gray-200 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Tag regions on {frameIds.length} selected frames</h2>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-200">
          Close
        </button>
      </div>

      <div className="flex gap-1">
        <button type="button" onClick={() => handleModeChange("create")} className={modeButtonClass(mode === "create")}>
          Create
        </button>
        <button type="button" onClick={() => handleModeChange("remove")} className={modeButtonClass(mode === "remove")}>
          Remove copies
        </button>
      </div>

      {mode === "create" &&
        (sourceLabels.length === 0 && !regionLabelsQuery.isLoading ? (
          <p className="text-gray-400">No regions on the selected frames</p>
        ) : (
          <select
            aria-label="Source label"
            value={sourceLabelId ?? ""}
            onChange={(event) => {
              setSourceLabelId(parseId(event.target.value));
              clearOutcome();
            }}
            className={selectClassName}
          >
            <option value="">Source label…</option>
            {sourceLabels.map((entry) => (
              <option key={entry.label_id} value={entry.label_id}>
                {entry.name} ({entry.count})
              </option>
            ))}
          </select>
        ))}

      <div className="flex gap-2">
        <select
          aria-label="Target category"
          value={targetCategoryId ?? ""}
          onChange={(event) => handleTargetCategoryChange(event.target.value)}
          className={selectClassName}
        >
          <option value="">Category…</option>
          {targetCategories.map((entry) => (
            <option key={entry.category.id} value={entry.category.id}>
              {entry.category.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Target label"
          value={targetLabelId ?? ""}
          onChange={(event) => {
            setTargetLabelId(parseId(event.target.value));
            clearOutcome();
          }}
          disabled={targetCategoryId === null}
          className={selectClassName}
        >
          <option value="">Label…</option>
          {targetLabels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      </div>

      {mode === "create" && (
        <label className="flex items-center gap-2 text-gray-300">
          <input
            type="checkbox"
            checked={skipManualFrames}
            onChange={(event) => {
              setSkipManualFrames(event.target.checked);
              clearOutcome();
            }}
          />
          Skip frames that already have hand-drawn regions of this type
        </label>
      )}

      {previewError ? (
        <p className="text-red-400">{previewError.message}</p>
      ) : mode === "create" && tagPreview.data ? (
        <div className="space-y-1 rounded border border-gray-800 bg-gray-950 p-2 text-gray-300">
          <p>
            Will create {tagPreview.data.regions} regions on {tagPreview.data.frames} frames.
          </p>
          {tagPreview.data.skipped_already_copied > 0 && (
            <p>
              Skipped: {tagPreview.data.skipped_already_copied} already tagged as{" "}
              {tagPreview.data.already_copied_label_names.join(", ")}.
            </p>
          )}
          {tagPreview.data.frames_with_manual_regions > 0 && (
            <p>
              {tagPreview.data.frames_with_manual_regions} frames have hand-drawn regions of this type
              {skipManualFrames ? " — skipped" : ""}
            </p>
          )}
        </div>
      ) : mode === "remove" && removePreview.data ? (
        <div className="rounded border border-gray-800 bg-gray-950 p-2 text-gray-300">
          <p>
            Will remove {removePreview.data.removed} copies. {removePreview.data.kept_reviewed} reviewed copies are
            kept.
          </p>
        </div>
      ) : null}

      {actionError ? (
        <p className="text-red-400">{actionError}</p>
      ) : (
        resultMessage && <p className="text-emerald-400">{resultMessage}</p>
      )}

      {mode === "create" ? (
        <button
          type="button"
          onClick={handleCreate}
          disabled={createDisabled}
          className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
        >
          Create {createCount} regions
        </button>
      ) : (
        <button
          type="button"
          onClick={handleRemove}
          disabled={removeDisabled}
          className={`rounded px-3 py-1.5 text-sm ${
            removeArmed ? "bg-red-700 text-white" : "bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40"
          }`}
        >
          {removeArmed ? "Confirm" : `Remove ${removeCount} copies`}
        </button>
      )}
    </div>
  );
}

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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function parseId(rawValue: string): number | null {
  const parsed = Number(rawValue);
  return rawValue !== "" && Number.isFinite(parsed) ? parsed : null;
}

export function TagRegionsPanel({ sequenceId, frameIds, taxonomyTree, onClose }: TagRegionsPanelProps) {
  const [mode, setMode] = useState<Mode>("create");
  const [sourceLabelId, setSourceLabelId] = useState<number | null>(null);
  const [sourceTypeId, setSourceTypeId] = useState<number | null>(null);
  const [targetTypeId, setTargetTypeId] = useState<number | null>(null);
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

  const regionLabelsQuery = useRegionLabels(frameIds, true);
  const allSourceLabels = regionLabelsQuery.data ?? [];

  // Classification (evaluation type) of each source label, so the list can be
  // narrowed to e.g. geometry or morphology, which share one category.
  const sourceTypes = useMemo(() => {
    const present = new Set(allSourceLabels.map((entry) => entry.label_id));
    return taxonomyTree.flatMap((node) =>
      node.evaluation_types
        .filter((entry) => entry.labels.some((label) => present.has(label.id)))
        .map((entry) => ({
          id: entry.evaluation_type.id,
          name: `${node.category.name} / ${entry.evaluation_type.name}`,
          labelIds: new Set(entry.labels.map((label) => label.id)),
        })),
    );
  }, [taxonomyTree, allSourceLabels]);
  const activeSourceType = sourceTypes.find((entry) => entry.id === sourceTypeId);
  const sourceLabels = activeSourceType
    ? allSourceLabels.filter((entry) => activeSourceType.labelIds.has(entry.label_id))
    : allSourceLabels;

  // A chosen source that is no longer on the selected frames (frames
  // unticked, regions deleted) must not keep driving the preview or Create.
  const sourceListed = sourceLabelId !== null && sourceLabels.some((entry) => entry.label_id === sourceLabelId);
  const activeSourceLabelId = sourceListed ? sourceLabelId : null;
  useEffect(() => {
    if (regionLabelsQuery.data !== undefined && sourceLabelId !== null && !sourceListed) {
      setSourceLabelId(null);
    }
  }, [regionLabelsQuery.data, sourceLabelId, sourceListed]);

  // Region-scoped classifications (evaluation types), each shown as
  // "Category / classification" so the category is not a separate step.
  const targetTypes = useMemo(
    () =>
      taxonomyTree.flatMap((node) =>
        node.evaluation_types
          .filter((entry) => entry.evaluation_type.annotation_scope === "region")
          .map((entry) => ({
            id: entry.evaluation_type.id,
            name: `${node.category.name} / ${entry.evaluation_type.name}`,
            labels: entry.labels.filter((label) => !label.is_abstract),
          }))
          .filter((entry) => entry.labels.length > 0),
      ),
    [taxonomyTree],
  );
  const activeTargetType = targetTypes.find((entry) => entry.id === targetTypeId);
  const targetLabels = activeTargetType?.labels ?? [];

  // Copying within one classification would stack a conflicting label (the
  // backend answers 422), so the source's classification is not offered.
  const sourceOwnType = sourceTypes.find(
    (entry) => activeSourceLabelId !== null && entry.labelIds.has(activeSourceLabelId),
  );
  const blockedTypeId = mode === "create" ? sourceOwnType?.id : undefined;
  const offeredTypeIds = targetTypes.filter((entry) => entry.id !== blockedTypeId).map((entry) => entry.id);
  const offeredKey = offeredTypeIds.join(",");

  useEffect(() => {
    if (blockedTypeId !== undefined && targetTypeId === blockedTypeId) {
      setTargetTypeId(null);
      setTargetLabelId(null);
    } else if (mode === "create" && activeSourceLabelId !== null && targetTypeId === null && offeredTypeIds.length === 1) {
      // Only one classification is left to copy into: pick it.
      setTargetTypeId(offeredTypeIds[0]);
    }
    // targetTypeId is left out so clearing the pick is not undone at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeSourceLabelId, blockedTypeId, offeredKey]);

  const tagParams = useMemo<TagRegionsParams | null>(
    () =>
      mode === "create" && activeSourceLabelId !== null && targetLabelId !== null
        ? { frameIds, sourceLabelId: activeSourceLabelId, targetLabelId, skipManualFrames }
        : null,
    // frameKey stands in for frameIds' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, frameKey, activeSourceLabelId, targetLabelId, skipManualFrames],
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

  const sourceName = allSourceLabels.find((entry) => entry.label_id === activeSourceLabelId)?.name ?? "the source";
  const targetName = targetLabels.find((label) => label.id === targetLabelId)?.name ?? "the target";
  const createCount = tagPreview.data?.regions ?? 0;
  const removeCount = removePreview.data?.removed ?? 0;

  // Any change to what Remove would act on disarms the confirm step.
  useEffect(() => {
    setRemoveArmed(false);
  }, [mode, targetLabelId, frameKey, removeCount]);
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

  function handleCreate() {
    if (tagParams === null) return;
    clearOutcome();
    tagRegions.mutate(tagParams, {
      onSuccess: (data) => setResultMessage(`Created ${plural(data.regions, "region")} on ${plural(data.frames, "frame")}.`),
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
    <div className="w-[28rem] space-y-3 rounded border border-gray-700 bg-gray-900 p-4 text-sm text-gray-200 shadow-xl">
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
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Copy from</p>
            {sourceTypes.length > 1 && (
              <select
                aria-label="Source classification"
                value={activeSourceType?.id ?? ""}
                onChange={(event) => {
                  setSourceTypeId(parseId(event.target.value));
                  setSourceLabelId(null);
                  clearOutcome();
                }}
                className={selectClassName}
              >
                <option value="">All classifications</option>
                {sourceTypes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label="Source label"
              value={activeSourceLabelId ?? ""}
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
          </section>
        ))}

      {mode === "create" && <p className="text-center text-gray-500">↓</p>}

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {mode === "create" ? "Copy to" : "Remove copies tagged as"}
        </p>
        <select
          aria-label="Target classification"
          value={activeTargetType?.id ?? ""}
          onChange={(event) => {
            setTargetTypeId(parseId(event.target.value));
            setTargetLabelId(null);
            clearOutcome();
          }}
          className={selectClassName}
        >
          <option value="">Classification…</option>
          {targetTypes.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={entry.id === blockedTypeId}>
              {entry.name}
              {entry.id === blockedTypeId ? " (same as source)" : ""}
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
          disabled={activeTargetType === undefined}
          className={selectClassName}
        >
          <option value="">Label…</option>
          {targetLabels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      </section>

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
          {tagPreview.data.regions > 0 ? (
            <p>
              Will tag {plural(tagPreview.data.regions, "region")} of {sourceName} as {targetName} on{" "}
              {plural(tagPreview.data.frames, "frame")}.
            </p>
          ) : (
            <p>
              Nothing to copy
              {tagPreview.data.skipped_already_copied > 0
                ? `: ${plural(tagPreview.data.skipped_already_copied, "region")} already tagged as ${tagPreview.data.already_copied_label_names.join(", ")}.`
                : "."}
            </p>
          )}
          {tagPreview.data.regions > 0 && tagPreview.data.skipped_already_copied > 0 && (
            <p>
              Skipped: {tagPreview.data.skipped_already_copied} already tagged as{" "}
              {tagPreview.data.already_copied_label_names.join(", ")}.
            </p>
          )}
          {tagPreview.data.skipped_already_copied > 0 && (
            <button type="button" onClick={() => handleModeChange("remove")} className="text-blue-400 hover:underline">
              Remove copies…
            </button>
          )}
          {tagPreview.data.frames_with_manual_regions > 0 && (
            <p>
              {plural(tagPreview.data.frames_with_manual_regions, "frame")}{" "}
              {tagPreview.data.frames_with_manual_regions === 1 ? "has" : "have"} hand-drawn regions of this type
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
          Create {plural(createCount, "region")}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleRemove}
          disabled={removeDisabled}
          className={`rounded px-3 py-1.5 text-sm disabled:opacity-40 ${
            removeArmed ? "bg-red-700 text-white" : "bg-gray-800 text-gray-200 hover:bg-gray-700"
          }`}
        >
          {removeArmed ? `Confirm remove ${removeCount} copies` : `Remove ${removeCount} copies`}
        </button>
      )}
    </div>
  );
}

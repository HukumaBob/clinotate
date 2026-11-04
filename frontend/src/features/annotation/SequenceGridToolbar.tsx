import { useCallback, useEffect, useMemo, useState } from "react";

import type { components } from "../../shared/api/generated/schema";
import { FrameCropPanel } from "./FrameCropPanel";
import { ParamPopover } from "./ParamPopover";
import { TagRegionsPanel } from "./TagRegionsPanel";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

interface SequenceGridToolbarProps {
  sequenceName: string;
  isSelectMode: boolean;
  onToggleSelectMode: () => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onCancel: () => void;
  qualityPercent?: number;
  onQualityPercentChange?: (value: number) => void;
  onRankQuality?: () => void;
  isRankQualityRunning?: boolean;
  similarityPercent?: number;
  onSimilarityPercentChange?: (value: number) => void;
  onFindSimilar?: () => void;
  isFindSimilarRunning?: boolean;
  hasAutoMarks?: boolean;
  onClearMarks?: () => void;
  taxonomyTree?: TaxonomyTreeNode[];
  onAssignClassification?: (labelId: number) => void;
  onClearClassification?: (categoryId: number, evaluationTypeId: number) => void;
  hasNoFindingsMarkedForAllSelected?: boolean;
  onToggleNoFindings?: () => void;
  totalCount?: number;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  sequenceId?: number;
  selectedFrameIds?: number[];
  firstSelectedImageUrl?: string;
  sequenceHasVideo?: boolean;
}

export function SequenceGridToolbar({
  sequenceName,
  isSelectMode,
  onToggleSelectMode,
  selectedCount,
  onDeleteSelected,
  onCancel,
  qualityPercent = 20,
  onQualityPercentChange = () => {},
  onRankQuality = () => {},
  isRankQualityRunning = false,
  similarityPercent = 85,
  onSimilarityPercentChange = () => {},
  onFindSimilar = () => {},
  isFindSimilarRunning = false,
  hasAutoMarks = false,
  onClearMarks = () => {},
  taxonomyTree = [],
  onAssignClassification = () => {},
  onClearClassification = () => {},
  hasNoFindingsMarkedForAllSelected = false,
  onToggleNoFindings = () => {},
  totalCount = 0,
  onSelectAll = () => {},
  onDeselectAll = () => {},
  sequenceId = 0,
  selectedFrameIds = [],
  firstSelectedImageUrl,
  sequenceHasVideo = false,
}: SequenceGridToolbarProps) {
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const [deleteArmed, setDeleteArmed] = useState(false);
  // One popover at a time: opening one closes the other.
  const [openPanel, setOpenPanel] = useState<"tagRegions" | "crop" | null>(null);
  const isTagRegionsOpen = openPanel === "tagRegions";
  const isCropOpen = openPanel === "crop";
  const closePanel = useCallback(() => setOpenPanel(null), []);
  const togglePanel = (panel: "tagRegions" | "crop") =>
    setOpenPanel((current) => (current === panel ? null : panel));
  // An emptied selection closes the panel, so a later selection does not reopen it.
  useEffect(() => {
    if (selectedCount === 0) setOpenPanel(null);
  }, [selectedCount]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedLabelId, setSelectedLabelId] = useState<number | null>(null);

  const classificationCategories = useMemo(
    () =>
      taxonomyTree
        .map((node) => {
          const evaluationTypeNode = node.evaluation_types.find(
            (candidate) => candidate.evaluation_type.annotation_scope === "frame",
          );
          return {
            category: node.category,
            evaluationTypeId: evaluationTypeNode?.evaluation_type.id ?? null,
            // Abstract labels are grouping containers for dataset export, not
            // things an annotator can put on a frame.
            labels: (evaluationTypeNode?.labels ?? []).filter((label) => !label.is_abstract),
          };
        })
        .filter((entry) => entry.labels.length > 0),
    [taxonomyTree],
  );

  const labelsForSelectedCategory =
    classificationCategories.find((entry) => entry.category.id === selectedCategoryId)?.labels ?? [];

  function handleCategoryChange(rawValue: string) {
    const parsed = Number(rawValue);
    setSelectedCategoryId(Number.isFinite(parsed) && rawValue !== "" ? parsed : null);
    setSelectedLabelId(null);
  }

  function handleLabelChange(rawValue: string) {
    const parsed = Number(rawValue);
    setSelectedLabelId(Number.isFinite(parsed) && rawValue !== "" ? parsed : null);
  }

  function handleAssignClick() {
    if (selectedLabelId !== null) {
      onAssignClassification(selectedLabelId);
    }
  }

  function handleClearClassificationClick() {
    const evaluationTypeId = classificationCategories.find(
      (entry) => entry.category.id === selectedCategoryId,
    )?.evaluationTypeId;
    if (selectedCategoryId !== null && evaluationTypeId != null) {
      onClearClassification(selectedCategoryId, evaluationTypeId);
    }
  }

  function handleDeleteClick() {
    if (deleteArmed) {
      onDeleteSelected();
      setDeleteArmed(false);
    } else {
      setDeleteArmed(true);
    }
  }

  function handleCancelClick() {
    setDeleteArmed(false);
    setOpenPanel(null);
    onCancel();
  }

  function handleQualityPercentChange(rawValue: string) {
    const parsed = Number(rawValue);
    const clamped = Math.min(99, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
    onQualityPercentChange(clamped);
  }

  function handleSimilarityPercentChange(rawValue: string) {
    const parsed = Number(rawValue);
    const clamped = Math.min(99, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
    onSimilarityPercentChange(clamped);
  }

  const noSelectionHint = selectedCount === 0 ? "Select frames first" : undefined;
  const selectedLabelName = labelsForSelectedCategory.find((label) => label.id === selectedLabelId)?.name;
  const selectedCategoryName = classificationCategories.find((entry) => entry.category.id === selectedCategoryId)
    ?.category.name;

  const buttonClass =
    "rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40";
  const quietButtonClass = "rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-40";
  const selectClass =
    "rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200 disabled:opacity-40";
  const inputClass = "w-20 rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200";
  const groupLabelClass = "text-xs font-semibold uppercase tracking-wide text-gray-500";

  return (
    <div className="space-y-3 border-b border-gray-800 px-8 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">{sequenceName}</h1>
        {isSelectMode ? (
          <>
            <span className="text-sm text-gray-300">
              {totalCount > 0 ? `${selectedCount} of ${totalCount} selected` : `${selectedCount} selected`}
            </span>
            <button
              type="button"
              aria-label={allSelected ? "Deselect all" : "Select all"}
              onClick={allSelected ? onDeselectAll : onSelectAll}
              disabled={totalCount === 0}
              className={buttonClass}
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
            {hasAutoMarks && (
              <button type="button" aria-label="Clear marks" onClick={onClearMarks} className={quietButtonClass}>
                Clear marks
              </button>
            )}
            {selectedCount === 0 && (
              <span className="text-sm text-gray-500">Tick frames to classify, tag regions or delete them.</span>
            )}
            <button
              type="button"
              aria-label="Cancel"
              onClick={handleCancelClick}
              className={`ml-auto ${quietButtonClass}`}
            >
              ✕ Cancel
            </button>
          </>
        ) : (
          <button type="button" aria-label="Select" onClick={onToggleSelectMode} className={`ml-auto ${buttonClass}`}>
            Select
          </button>
        )}
      </div>

      {isSelectMode && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={groupLabelClass}>Classify</span>
            <select
              aria-label="Classification category"
              value={selectedCategoryId ?? ""}
              onChange={(event) => handleCategoryChange(event.target.value)}
              className={selectClass}
            >
              <option value="">Category…</option>
              {classificationCategories.map((entry) => (
                <option key={entry.category.id} value={entry.category.id}>
                  {entry.category.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Classification label"
              value={selectedLabelId ?? ""}
              onChange={(event) => handleLabelChange(event.target.value)}
              disabled={selectedCategoryId === null}
              className={selectClass}
            >
              <option value="">Label…</option>
              {labelsForSelectedCategory.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Assign"
              onClick={handleAssignClick}
              disabled={selectedLabelId === null || selectedCount === 0}
              title={noSelectionHint ?? (selectedLabelId === null ? "Pick a category and a label first" : undefined)}
              className={buttonClass}
            >
              {selectedLabelName && selectedCount > 0 ? `Assign ${selectedLabelName} to ${selectedCount}` : "Assign"}
            </button>
            <button
              type="button"
              aria-label="Clear"
              onClick={handleClearClassificationClick}
              disabled={selectedCategoryId === null || selectedCount === 0}
              title={
                noSelectionHint ??
                (selectedCategoryId === null
                  ? "Pick a category first"
                  : `Remove the ${selectedCategoryName} classification from the selected frames`)
              }
              className={quietButtonClass}
            >
              Clear
            </button>
            <button
              type="button"
              aria-label={hasNoFindingsMarkedForAllSelected ? "Unmark no findings" : "Mark no findings"}
              onClick={onToggleNoFindings}
              disabled={selectedCount === 0}
              title={noSelectionHint}
              className={buttonClass}
            >
              {hasNoFindingsMarkedForAllSelected ? "Unmark no findings" : "Mark no findings"}
            </button>
          </div>

          <div className="flex items-center gap-2 border-l border-gray-800 pl-6">
            <span className={groupLabelClass}>Regions</span>
            <div className="relative">
              <button
                type="button"
                aria-label="Tag regions"
                aria-expanded={isTagRegionsOpen && selectedCount > 0}
                onClick={() => togglePanel("tagRegions")}
                disabled={selectedCount === 0}
                title={noSelectionHint}
                className={buttonClass}
              >
                Tag regions…
              </button>
              {isTagRegionsOpen && selectedCount > 0 && (
                <div className="absolute left-0 top-full z-20 mt-2">
                  <TagRegionsPanel
                    sequenceId={sequenceId}
                    frameIds={selectedFrameIds}
                    taxonomyTree={taxonomyTree}
                    onClose={closePanel}
                  />
                </div>
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                aria-label="Crop"
                aria-expanded={isCropOpen && selectedCount > 0}
                onClick={() => togglePanel("crop")}
                disabled={selectedCount === 0}
                title={noSelectionHint}
                className={buttonClass}
              >
                Crop…
              </button>
              {isCropOpen && selectedCount > 0 && (
                <div className="absolute left-0 top-full z-20 mt-2">
                  <FrameCropPanel
                    sequenceId={sequenceId}
                    frameIds={selectedFrameIds}
                    previewUrl={firstSelectedImageUrl}
                    hasVideo={sequenceHasVideo}
                    onClose={closePanel}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 border-l border-gray-800 pl-6">
            <span className={groupLabelClass}>Analyze sequence</span>
            <ParamPopover
              label="Rank Quality"
              runningLabel="Ranking…"
              isRunning={isRankQualityRunning}
              description="Scores every frame of the sequence and ticks the worst ones."
              onRun={onRankQuality}
            >
              <label className="block space-y-1">
                <span className="text-gray-300">Tick the worst … % of frames</span>
                <input
                  type="number"
                  aria-label="Quality percent"
                  min={1}
                  max={99}
                  value={qualityPercent}
                  onChange={(event) => handleQualityPercentChange(event.target.value)}
                  className={inputClass}
                />
              </label>
            </ParamPopover>
            <ParamPopover
              label="Find Similar"
              runningLabel="Finding…"
              isRunning={isFindSimilarRunning}
              description="Ticks near-duplicate frames, so you can delete the repeats."
              onRun={onFindSimilar}
            >
              <label className="block space-y-1">
                <span className="text-gray-300">Duplicate when at least … % similar</span>
                <input
                  type="number"
                  aria-label="Similarity percent"
                  min={1}
                  max={99}
                  value={similarityPercent}
                  onChange={(event) => handleSimilarityPercentChange(event.target.value)}
                  className={inputClass}
                />
              </label>
            </ParamPopover>
          </div>

          <button
            type="button"
            aria-label={deleteArmed ? "Confirm delete" : "Delete selected"}
            onClick={handleDeleteClick}
            disabled={selectedCount === 0}
            title={noSelectionHint}
            className={`ml-auto rounded px-3 py-1.5 text-sm disabled:opacity-40 ${
              deleteArmed
                ? "bg-red-700 text-white"
                : "border border-red-900 text-red-400 hover:bg-red-950"
            }`}
          >
            {deleteArmed ? `Confirm delete ${selectedCount}` : selectedCount > 0 ? `🗑 Delete ${selectedCount}` : "🗑 Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

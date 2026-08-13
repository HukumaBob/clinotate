import { useMemo, useState } from "react";

import type { components } from "../../shared/api/generated/schema";

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
  frameClassificationEvaluationTypeName?: string;
  onAssignClassification?: (labelId: number) => void;
  onClearClassification?: (categoryId: number, evaluationTypeId: number) => void;
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
  frameClassificationEvaluationTypeName = "Frame classification",
  onAssignClassification = () => {},
  onClearClassification = () => {},
}: SequenceGridToolbarProps) {
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedLabelId, setSelectedLabelId] = useState<number | null>(null);

  const classificationCategories = useMemo(
    () =>
      taxonomyTree
        .map((node) => {
          const evaluationTypeNode = node.evaluation_types.find(
            (candidate) => candidate.evaluation_type.name === frameClassificationEvaluationTypeName,
          );
          return {
            category: node.category,
            evaluationTypeId: evaluationTypeNode?.evaluation_type.id ?? null,
            labels: evaluationTypeNode?.labels ?? [],
          };
        })
        .filter((entry) => entry.labels.length > 0),
    [taxonomyTree, frameClassificationEvaluationTypeName],
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

  return (
    <div className="flex items-center gap-4 border-b border-gray-800 px-8 py-4">
      <h1 className="text-xl font-semibold">{sequenceName}</h1>
      <div className="ml-auto flex items-center gap-3">
        {isSelectMode && (
          <>
            <select
              aria-label="Classification category"
              value={selectedCategoryId ?? ""}
              onChange={(event) => handleCategoryChange(event.target.value)}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
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
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200 disabled:opacity-40"
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
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              Assign
            </button>
            <button
              type="button"
              aria-label="Clear"
              onClick={handleClearClassificationClick}
              disabled={selectedCategoryId === null || selectedCount === 0}
              className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-40"
            >
              Clear
            </button>
            <input
              type="number"
              aria-label="Quality percent"
              min={1}
              max={99}
              value={qualityPercent}
              onChange={(event) => handleQualityPercentChange(event.target.value)}
              className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
            />
            <button
              type="button"
              aria-label="Rank Quality"
              onClick={onRankQuality}
              disabled={isRankQualityRunning}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              {isRankQualityRunning ? "Ranking…" : "Rank Quality"}
            </button>
            <input
              type="number"
              aria-label="Similarity percent"
              min={1}
              max={99}
              value={similarityPercent}
              onChange={(event) => handleSimilarityPercentChange(event.target.value)}
              className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
            />
            <button
              type="button"
              aria-label="Find Similar"
              onClick={onFindSimilar}
              disabled={isFindSimilarRunning}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              {isFindSimilarRunning ? "Finding…" : "Find Similar"}
            </button>
            {hasAutoMarks && (
              <button
                type="button"
                aria-label="Clear marks"
                onClick={onClearMarks}
                className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
              >
                Clear marks
              </button>
            )}
            <span className="text-sm text-gray-400">{selectedCount} selected</span>
            <button
              type="button"
              aria-label={deleteArmed ? "Confirm delete" : "Delete selected"}
              onClick={handleDeleteClick}
              disabled={selectedCount === 0}
              className={`rounded px-3 py-1.5 text-sm ${
                deleteArmed
                  ? "bg-red-700 text-white"
                  : "bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40"
              }`}
            >
              {deleteArmed ? "Confirm" : "🗑 Delete"}
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={handleCancelClick}
              className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
            >
              ✕ Cancel
            </button>
          </>
        )}
        {!isSelectMode && (
          <button
            type="button"
            aria-label="Select"
            onClick={onToggleSelectMode}
            className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
          >
            Select
          </button>
        )}
      </div>
    </div>
  );
}

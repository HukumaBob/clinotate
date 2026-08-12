import { useState } from "react";

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
  hasAutoMarks?: boolean;
  onClearMarks?: () => void;
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
  hasAutoMarks = false,
  onClearMarks = () => {},
}: SequenceGridToolbarProps) {
  const [deleteArmed, setDeleteArmed] = useState(false);

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

  return (
    <div className="flex items-center gap-4 border-b border-gray-800 px-8 py-4">
      <h1 className="text-xl font-semibold">{sequenceName}</h1>
      <div className="ml-auto flex items-center gap-3">
        {isSelectMode && (
          <>
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

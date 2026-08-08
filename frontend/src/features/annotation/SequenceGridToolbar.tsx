import { useState } from "react";

interface SequenceGridToolbarProps {
  sequenceName: string;
  isSelectMode: boolean;
  onToggleSelectMode: () => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onCancel: () => void;
}

export function SequenceGridToolbar({
  sequenceName,
  isSelectMode,
  onToggleSelectMode,
  selectedCount,
  onDeleteSelected,
  onCancel,
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

  return (
    <div className="flex items-center gap-4 border-b border-gray-800 px-8 py-4">
      <h1 className="text-xl font-semibold">{sequenceName}</h1>
      <div className="ml-auto flex items-center gap-3">
        {isSelectMode && (
          <>
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

import { useState } from "react";

export function MediaNameCell({
  displayName,
  secondaryLine,
  isEditing,
  isSaving,
  error,
  onOpen,
  onStartEdit,
  onCancelEdit,
  onSave,
}: {
  displayName: string;
  secondaryLine?: string;
  isEditing: boolean;
  isSaving: boolean;
  error?: string;
  onOpen: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (name: string) => void;
}) {
  const [draft, setDraft] = useState(displayName);

  function beginEdit() {
    setDraft(displayName);
    onStartEdit();
  }

  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && !isSaving;

  if (isEditing) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <input
            aria-label="Name"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) onSave(trimmed);
              if (e.key === "Escape") onCancelEdit();
            }}
            className="w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100"
          />
          <button
            onClick={() => onSave(trimmed)}
            disabled={!canSave}
            className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={onCancelEdit}
            className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
          >
            Cancel
          </button>
        </div>
        {secondaryLine && <div className="mt-1 text-xs text-gray-500">{secondaryLine}</div>}
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <div onClick={onOpen} className="cursor-pointer">
          <div className="text-blue-400 hover:text-blue-300 hover:underline">{displayName}</div>
          {secondaryLine && <div className="text-xs text-gray-500">{secondaryLine}</div>}
        </div>
        <button
          onClick={beginEdit}
          aria-label={`Rename "${displayName}"`}
          title="Rename"
          className="rounded border border-gray-700 px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
        >
          ✎
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

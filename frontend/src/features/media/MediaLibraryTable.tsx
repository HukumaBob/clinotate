import { useState } from "react";

import { useDeleteSequence, useDeleteVideo, useMediaLibrary } from "../../entities/useMediaLibrary";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaLibraryTable({
  onSelectVideo,
}: {
  onSelectVideo?: (videoId: number) => void;
} = {}) {
  const libraryQuery = useMediaLibrary();
  const deleteVideo = useDeleteVideo();
  const deleteSequence = useDeleteSequence();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [errorsByKey, setErrorsByKey] = useState<Record<string, string>>({});

  function handleDelete(id: number, kind: "video" | "photo") {
    const key = `${kind}-${id}`;
    const mutation = kind === "video" ? deleteVideo : deleteSequence;
    mutation.mutate(id, {
      onSuccess: () => {
        setConfirmingKey(null);
        setErrorsByKey((errors) => ({ ...errors, [key]: "" }));
      },
      onError: (error: unknown) => {
        const detail = (error as { detail?: string } | undefined)?.detail ?? "Delete failed";
        setErrorsByKey((errors) => ({ ...errors, [key]: detail }));
      },
    });
  }

  return (
    <table className="w-full text-left text-sm text-gray-300">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400">
          <th className="py-2">Filename</th>
          <th>Type</th>
          <th>Procedure</th>
          <th>Uploaded</th>
          <th>Size</th>
          <th>Sequences</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {(libraryQuery.data ?? []).map((item) => {
          const key = `${item.kind}-${item.id}`;
          return (
            <tr key={key} className="border-b border-gray-900">
              <td
                className={`py-2 ${item.kind === "video" ? "cursor-pointer text-blue-400 hover:underline" : ""}`}
                onClick={item.kind === "video" ? () => onSelectVideo?.(item.id) : undefined}
              >
                {item.filename}
              </td>
              <td>{item.kind}</td>
              <td>{item.procedure_id ?? "—"}</td>
              <td>{new Date(item.uploaded_at).toLocaleDateString()}</td>
              <td>{formatSize(item.size_bytes)}</td>
              <td>{item.linked_sequence_count}</td>
              <td>
                {confirmingKey === key ? (
                  <button
                    onClick={() => handleDelete(item.id, item.kind)}
                    className="rounded bg-red-600 px-2 py-1 text-white hover:bg-red-500"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmingKey(key)}
                    className="rounded border border-gray-700 px-2 py-1 hover:bg-gray-800"
                  >
                    Delete
                  </button>
                )}
                {errorsByKey[key] && (
                  <p className="mt-1 text-xs text-red-400">{errorsByKey[key]}</p>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

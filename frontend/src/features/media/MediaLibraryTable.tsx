import { useState } from "react";

import { useDeleteSequence, useDeleteVideo, useMediaLibrary } from "../../entities/useMediaLibrary";
import { useProcedures } from "../../entities/useProcedures";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function MediaLibraryTable() {
  const libraryQuery = useMediaLibrary();
  const proceduresQuery = useProcedures();
  const deleteVideo = useDeleteVideo();
  const deleteSequence = useDeleteSequence();
  const [errorByItem, setErrorByItem] = useState<Record<string, string>>({});

  const procedureNameById = new Map((proceduresQuery.data ?? []).map((p) => [p.id, p.name]));

  function handleDelete(kind: "video" | "photo", id: number) {
    const key = `${kind}-${id}`;
    const confirmed = window.confirm("Delete this item? This cannot be undone.");
    if (!confirmed) return;
    setErrorByItem((prev) => ({ ...prev, [key]: "" }));
    const mutation = kind === "video" ? deleteVideo : deleteSequence;
    mutation.mutate(id, {
      onError: (mutationError: unknown) => {
        const detail =
          (mutationError as { detail?: string } | undefined)?.detail ?? "Delete failed";
        setErrorByItem((prev) => ({ ...prev, [key]: detail }));
      },
    });
  }

  const items = libraryQuery.data ?? [];

  return (
    <div className="rounded border border-gray-800 bg-gray-900">
      <table className="w-full text-left text-sm text-gray-300">
        <thead>
          <tr className="border-b border-gray-800 text-gray-400">
            <th className="px-4 py-2 font-medium">Filename</th>
            <th className="px-4 py-2 font-medium">Kind</th>
            <th className="px-4 py-2 font-medium">Procedure</th>
            <th className="px-4 py-2 font-medium">Uploaded</th>
            <th className="px-4 py-2 font-medium">Size</th>
            <th className="px-4 py-2 font-medium">Sequences</th>
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const key = `${item.kind}-${item.id}`;
            const itemError = errorByItem[key];
            return (
              <tr key={key} className="border-b border-gray-800 last:border-0">
                <td className="px-4 py-2">{item.filename}</td>
                <td className="px-4 py-2">
                  <span className="rounded bg-gray-800 px-2 py-0.5 text-xs uppercase text-gray-300">
                    {item.kind}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {item.procedure_id !== null
                    ? (procedureNameById.get(item.procedure_id) ?? "—")
                    : "—"}
                </td>
                <td className="px-4 py-2">{new Date(item.uploaded_at).toLocaleDateString()}</td>
                <td className="px-4 py-2">{formatSize(item.size_bytes)}</td>
                <td className="px-4 py-2">{item.linked_sequence_count}</td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => handleDelete(item.kind, item.id)}
                    className="rounded border border-red-800 px-2 py-1 text-xs text-red-400 hover:bg-red-950"
                  >
                    Delete
                  </button>
                  {itemError && <p className="mt-1 text-xs text-red-400">{itemError}</p>}
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td className="px-4 py-6 text-center text-gray-500" colSpan={7}>
                No media uploaded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

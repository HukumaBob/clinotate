import { useState } from "react";

import { useDeleteSequence, useDeleteVideo, useMediaLibrary } from "../../entities/useMediaLibrary";
import { useProcedures } from "../../entities/useProcedures";

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
  const proceduresQuery = useProcedures();
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
    <table className="w-full text-left text-sm">
      <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase text-gray-400">
        <tr>
          <th className="py-1.5 px-3">Filename</th>
          <th className="py-1.5 px-3">Type</th>
          <th className="py-1.5 px-3">Procedure</th>
          <th className="py-1.5 px-3">Uploaded</th>
          <th className="py-1.5 px-3">Last edited</th>
          <th className="py-1.5 px-3">Size</th>
          <th className="py-1.5 px-3">Sequences</th>
          <th className="py-1.5 px-3" />
        </tr>
      </thead>
      <tbody>
        {(libraryQuery.data ?? []).map((item) => {
          const key = `${item.kind}-${item.id}`;
          const procedureName =
            item.procedure_id === null
              ? "—"
              : (proceduresQuery.data?.find((procedure) => procedure.id === item.procedure_id)?.name ??
                item.procedure_id);
          return (
            <tr key={key} className="border-b border-gray-800 hover:bg-gray-900/50">
              <td
                className={`py-1.5 px-3 text-gray-100 ${item.kind === "video" ? "cursor-pointer text-blue-400 hover:text-blue-300 hover:underline" : ""}`}
                onClick={item.kind === "video" ? () => onSelectVideo?.(item.id) : undefined}
              >
                {item.kind === "video" ? (
                  <div>
                    <div>{item.title}</div>
                    <div className="text-xs text-gray-500">{item.filename}</div>
                  </div>
                ) : (
                  item.filename
                )}
              </td>
              <td className="py-1.5 px-3 text-gray-100">{item.kind}</td>
              <td className="py-1.5 px-3 text-gray-100">{procedureName}</td>
              <td className="py-1.5 px-3 text-gray-100">{new Date(item.uploaded_at).toLocaleDateString()}</td>
              <td className="py-1.5 px-3 text-gray-100">{new Date(item.last_edited_at).toLocaleDateString()}</td>
              <td className="py-1.5 px-3 text-gray-100">{formatSize(item.size_bytes)}</td>
              <td className="py-1.5 px-3 text-gray-100">{item.linked_sequence_count}</td>
              <td className="py-1.5 px-3 text-right">
                {confirmingKey === key ? (
                  <button
                    onClick={() => handleDelete(item.id, item.kind)}
                    className="rounded bg-red-700 px-3 py-1.5 text-white hover:bg-red-600"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmingKey(key)}
                    className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
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

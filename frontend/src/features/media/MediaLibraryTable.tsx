import { useEffect, useState } from "react";

import { useDeleteSequence, useDeleteVideo, useMediaLibrary } from "../../entities/useMediaLibrary";
import type { MediaLibraryParams } from "../../entities/useMediaLibrary";
import { useProcedures } from "../../entities/useProcedures";
import { MediaLibraryPagination } from "./MediaLibraryPagination";
import { useDebouncedValue } from "./useDebouncedValue";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SortKey = NonNullable<MediaLibraryParams["sort"]>;

const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "uploaded_at", label: "Uploaded" },
  { key: "last_edited_at", label: "Last edited" },
  { key: "size_bytes", label: "Size" },
  { key: "linked_sequence_count", label: "Sequences" },
];

const PAGE_SIZE = 25;

export function MediaLibraryTable({
  onSelectVideo,
  onSelectSequence,
}: {
  onSelectVideo?: (videoId: number) => void;
  onSelectSequence?: (sequenceId: number) => void;
} = {}) {
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, 300);
  const [type, setType] = useState<"video" | "photo" | undefined>(undefined);
  const [procedureId, setProcedureId] = useState<number | undefined>(undefined);
  const [sort, setSort] = useState<SortKey>("uploaded_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const libraryQuery = useMediaLibrary({
    search: search || undefined,
    type,
    procedureId,
    sort,
    order,
    page,
    pageSize: PAGE_SIZE,
  });
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

  function handleSortClick(key: SortKey) {
    if (sort === key) {
      setOrder((current) => (current === "desc" ? "asc" : "desc"));
    } else {
      setSort(key);
      setOrder("desc");
    }
    setPage(1);
  }

  function handleFilterChange<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  const items = libraryQuery.data?.items ?? [];
  const total = libraryQuery.data?.total ?? 0;

  useEffect(() => {
    if (!libraryQuery.data || total === 0) return;
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > lastPage) {
      setPage(lastPage);
    }
  }, [libraryQuery.data, total, page]);

  return (
    <div>
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase text-gray-400">
          <tr>
            <th className="py-1.5 px-3">
              <div>Filename</div>
              <input
                type="text"
                placeholder="Search..."
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setPage(1);
                }}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs normal-case text-gray-100"
              />
            </th>
            <th className="py-1.5 px-3">
              <label htmlFor="media-type-filter">Type</label>
              <select
                id="media-type-filter"
                value={type ?? ""}
                onChange={(e) =>
                  handleFilterChange(setType, (e.target.value || undefined) as "video" | "photo" | undefined)
                }
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs normal-case text-gray-100"
              >
                <option value="">All types</option>
                <option value="video">video</option>
                <option value="photo">photo</option>
              </select>
            </th>
            <th className="py-1.5 px-3">
              <label htmlFor="media-procedure-filter">Procedure</label>
              <select
                id="media-procedure-filter"
                value={procedureId ?? ""}
                onChange={(e) =>
                  handleFilterChange(
                    setProcedureId,
                    e.target.value ? Number(e.target.value) : undefined
                  )
                }
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs normal-case text-gray-100"
              >
                <option value="">All procedures</option>
                {(Array.isArray(proceduresQuery.data) ? proceduresQuery.data : []).map((procedure) => (
                  <option key={procedure.id} value={procedure.id}>
                    {procedure.name}
                  </option>
                ))}
              </select>
            </th>
            {SORTABLE_COLUMNS.map((column) => (
              <th key={column.key} className="py-1.5 px-3">
                <button
                  onClick={() => handleSortClick(column.key)}
                  className="flex items-center gap-1 uppercase text-gray-400 hover:text-gray-200"
                >
                  {column.label}
                  {sort === column.key && <span>{order === "desc" ? "▼" : "▲"}</span>}
                </button>
              </th>
            ))}
            <th className="py-1.5 px-3" />
          </tr>
        </thead>
        <tbody>
          {libraryQuery.isPending ? (
            <tr>
              <td colSpan={8} className="py-4 px-3 text-center text-gray-500">
                Loading…
              </td>
            </tr>
          ) : libraryQuery.isError ? (
            <tr>
              <td colSpan={8} className="py-4 px-3 text-center text-red-400">
                Failed to load media library
              </td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td colSpan={8} className="py-4 px-3 text-center text-gray-500">
                No media matches your filters
              </td>
            </tr>
          ) : (
            items.map((item) => {
              const key = `${item.kind}-${item.id}`;
              const procedureName =
                item.procedure_id === null
                  ? "—"
                  : ((Array.isArray(proceduresQuery.data) ? proceduresQuery.data : []).find(
                      (procedure) => procedure.id === item.procedure_id
                    )?.name ?? item.procedure_id);
              return (
                <tr key={key} className="border-b border-gray-800 hover:bg-gray-900/50">
                  <td
                    className="py-1.5 px-3 text-gray-100 cursor-pointer text-blue-400 hover:text-blue-300 hover:underline"
                    onClick={
                      item.kind === "video" ? () => onSelectVideo?.(item.id) : () => onSelectSequence?.(item.id)
                    }
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
                    {errorsByKey[key] && <p className="mt-1 text-xs text-red-400">{errorsByKey[key]}</p>}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      <MediaLibraryPagination total={total} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}

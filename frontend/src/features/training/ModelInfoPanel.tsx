import { useEffect, useMemo, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { MetricsChart } from "./MetricsChart";

type ModelMetricsRead = components["schemas"]["ModelMetricsRead"];
type ArtifactRead = components["schemas"]["ArtifactRead"];

interface ModelInfoPanelProps {
  versionId: number;
  onClose: () => void;
}

type SortState = { column: string; direction: "asc" | "desc" } | null;

/** Column order for the per-class table: `class` always leads, then every
 * other key in first-seen order across rows. Never a hardcoded list --
 * different trainers report different columns (mAP50/Box-P for YOLO,
 * ap_50 for RT-DETR, ...). */
function deriveColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === "class") continue;
      if (!known.has(key)) {
        known.add(key);
        seen.push(key);
      }
    }
  }
  return ["class", ...seen];
}

function formatCell(value: unknown): string {
  if (typeof value === "number") {
    return value.toFixed(4);
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

export function ModelInfoPanel({ versionId, onClose }: ModelInfoPanelProps) {
  const [data, setData] = useState<ModelMetricsRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<SortState>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    setSort(null);

    apiClient
      .GET("/training/models/{version_id}/metrics", {
        params: { path: { version_id: versionId } },
      })
      .then(({ data: result }) => {
        if (cancelled) return;
        if (!result) {
          setError(true);
        } else {
          setData(result);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [versionId]);

  const perClassRows = (data?.per_class ?? []) as Array<Record<string, unknown>>;
  const columns = useMemo(() => deriveColumns(perClassRows), [perClassRows]);

  const sortedRows = useMemo(() => {
    if (!sort) return perClassRows;
    const { column, direction } = sort;
    const copy = [...perClassRows];
    copy.sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      const an = typeof av === "number" ? av : Number.NEGATIVE_INFINITY;
      const bn = typeof bv === "number" ? bv : Number.NEGATIVE_INFINITY;
      return direction === "asc" ? an - bn : bn - an;
    });
    return copy;
  }, [perClassRows, sort]);

  function toggleSort(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) {
        return { column, direction: "desc" };
      }
      return { column, direction: prev.direction === "desc" ? "asc" : "desc" };
    });
  }

  async function handleArtifactClick(artifact: ArtifactRead) {
    const { data: result } = await apiClient.GET(
      "/training/models/{version_id}/artifacts/{index}",
      { params: { path: { version_id: versionId, index: artifact.index } } },
    );
    if (result?.download_url) {
      window.open(result.download_url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div className="flex flex-col gap-4 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-4 text-gray-200">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-100">Model info</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
        >
          Close
        </button>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {!loading && error && (
        <p className="text-sm text-gray-500">Failed to load model info.</p>
      )}

      {!loading && !error && data && (
        <>
          {(data.history ?? []).length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase text-gray-500">
                Training curve
              </h3>
              <MetricsChart history={data.history as Array<Record<string, number>>} />
            </section>
          )}

          {data.confusion && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase text-gray-500">
                Confusion matrix
              </h3>
              <ConfusionMatrix
                confusion={
                  data.confusion as unknown as { labels: string[]; matrix: number[][] }
                }
              />
            </section>
          )}

          {perClassRows.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase text-gray-500">
                Per-class metrics
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-gray-200">
                  <thead>
                    <tr className="border-b border-gray-800 text-gray-400">
                      {columns.map((column) => {
                        const isClass = column === "class";
                        return (
                          <th key={column} className="px-2 py-1 font-normal">
                            {isClass ? (
                              column
                            ) : (
                              <button
                                type="button"
                                onClick={() => toggleSort(column)}
                                className="hover:text-gray-100"
                              >
                                {column}
                                {sort?.column === column
                                  ? sort.direction === "desc"
                                    ? " ↓"
                                    : " ↑"
                                  : ""}
                              </button>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-gray-900">
                        {columns.map((column) => (
                          <td key={column} className="px-2 py-1">
                            {formatCell(row[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {(data.artifacts ?? []).length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase text-gray-500">Artifacts</h3>
              <ul className="flex flex-col gap-1">
                {data.artifacts.map((artifact) => (
                  <li key={artifact.index}>
                    <button
                      type="button"
                      onClick={() => handleArtifactClick(artifact)}
                      className="text-xs text-blue-400 hover:text-blue-300 hover:underline"
                    >
                      {artifact.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

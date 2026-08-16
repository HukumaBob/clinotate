import { useEffect, useMemo, useState } from "react";

import { useSequencesList } from "../../entities/useSequencesList";
import { useTagsTree } from "../../entities/useTaxonomy";
import {
  useCreateDataset,
  useDatasetBalance,
  useDatasets,
  useDeleteDataset,
} from "../../entities/useDatasets";
import type { components } from "../../shared/api/generated/schema";
import { BalancePanel } from "./BalancePanel";
import { DatasetsTable } from "./DatasetsTable";

type TaskType = components["schemas"]["TaskType"];

const TASK_TYPES: TaskType[] = ["classification", "detection", "segmentation"];
const DEBOUNCE_MS = 300;

export function DatasetsPage() {
  const [selectedSequenceIds, setSelectedSequenceIds] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [taskType, setTaskType] = useState<TaskType>("classification");
  const [threshold, setThreshold] = useState(10);
  const [name, setName] = useState("");
  const [trainPercent, setTrainPercent] = useState(70);
  const [valPercent, setValPercent] = useState(20);
  const [search, setSearch] = useState("");

  const testPercent = Math.max(0, 100 - trainPercent - valPercent);

  const sequencesQuery = useSequencesList({
    procedureId: null,
    videoId: null,
    search,
    labeled: "all",
    page: 1,
    pageSize: 50,
  });
  const datasetsQuery = useDatasets();
  const treeQuery = useTagsTree(null);
  const createDataset = useCreateDataset();
  const deleteDataset = useDeleteDataset();

  const sequences = sequencesQuery.data?.items ?? [];
  const datasets = datasetsQuery.data ?? [];

  const collapsibleLabelIds = useMemo(() => {
    const tree = treeQuery.data ?? [];
    const ids = new Set<number>();
    for (const categoryNode of tree) {
      for (const evalTypeNode of categoryNode.evaluation_types) {
        for (const label of evalTypeNode.labels) {
          if (label.parent_label_id != null) {
            ids.add(label.parent_label_id);
          }
        }
      }
    }
    return ids;
  }, [treeQuery.data]);

  const labelNamesById = useMemo(() => {
    const tree = treeQuery.data ?? [];
    const namesById = new Map<number, string>();
    for (const categoryNode of tree) {
      for (const evalTypeNode of categoryNode.evaluation_types) {
        for (const label of evalTypeNode.labels) {
          namesById.set(label.id, label.name);
        }
      }
    }
    return namesById;
  }, [treeQuery.data]);

  const parentLabelIdByChildId = useMemo(() => {
    const tree = treeQuery.data ?? [];
    const parentById = new Map<number, number>();
    for (const categoryNode of tree) {
      for (const evalTypeNode of categoryNode.evaluation_types) {
        for (const label of evalTypeNode.labels) {
          if (label.parent_label_id != null) {
            parentById.set(label.id, label.parent_label_id);
          }
        }
      }
    }
    return parentById;
  }, [treeQuery.data]);

  const excludedLabels = useMemo(() => {
    return Array.from(excluded).map((id) => ({
      id,
      name: labelNamesById.get(id) ?? `label ${id}`,
    }));
  }, [excluded, labelNamesById]);

  // Debounce the balance request so a click storm doesn't fire a request per click.
  const [debouncedRequest, setDebouncedRequest] = useState({
    sequence_ids: [] as number[],
    task_type: taskType,
    grouping_overrides: { expand: [] as number[] },
    excluded_label_ids: [] as number[],
    threshold,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedRequest({
        sequence_ids: Array.from(selectedSequenceIds),
        task_type: taskType,
        grouping_overrides: { expand: Array.from(collapsed) },
        excluded_label_ids: Array.from(excluded),
        threshold,
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [selectedSequenceIds, collapsed, excluded, taskType, threshold]);

  const balanceQuery = useDatasetBalance(debouncedRequest, debouncedRequest.sequence_ids.length > 0);

  function toggleSequence(sequenceId: number) {
    setSelectedSequenceIds((current) => {
      const next = new Set(current);
      if (next.has(sequenceId)) {
        next.delete(sequenceId);
      } else {
        next.add(sequenceId);
      }
      return next;
    });
  }

  function toggleCollapse(labelId: number) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(labelId)) {
        next.delete(labelId);
      } else {
        next.add(labelId);
      }
      return next;
    });
  }

  function toggleExclude(labelId: number) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(labelId)) {
        next.delete(labelId);
      } else {
        next.add(labelId);
      }
      return next;
    });
  }

  async function handleSave() {
    if (!name.trim()) return;
    await createDataset.mutateAsync({
      name: name.trim(),
      task_type: taskType,
      sequence_ids: Array.from(selectedSequenceIds),
      split_config: { train: trainPercent, val: valPercent, test: testPercent },
      grouping_overrides: { expand: Array.from(collapsed) },
      excluded_label_ids: Array.from(excluded),
      threshold,
    });
    setName("");
  }

  const splitExceeds100 = trainPercent + valPercent > 100;
  const noSequencesSelected = selectedSequenceIds.size === 0;
  const canSave =
    name.trim().length > 0 &&
    !splitExceeds100 &&
    !createDataset.isPending &&
    !noSequencesSelected;

  const describedByIds = [
    splitExceeds100 ? "split-exceeds-100-message" : null,
    noSequencesSelected ? "no-sequences-selected-message" : null,
  ].filter((id): id is string => id !== null);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-950 p-8 text-gray-100">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <h1 className="text-lg font-semibold">Datasets</h1>
      </div>

      <div className="grid flex-1 grid-cols-2 gap-6 overflow-hidden">
        <div className="flex flex-col gap-4 overflow-hidden">
          <div className="rounded border border-gray-800 bg-gray-900 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                <span>Task type</span>
                <select
                  className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
                  value={taskType}
                  onChange={(e) => setTaskType(e.target.value as TaskType)}
                >
                  {TASK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span>Threshold</span>
                <input
                  type="number"
                  min={0}
                  className="w-16 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
              </label>
              <input
                type="text"
                placeholder="Search sequences…"
                className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-left text-sm text-gray-200">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400">
                    <th className="px-2 py-1 font-normal" />
                    <th className="px-2 py-1 font-normal">Name</th>
                    <th className="px-2 py-1 font-normal">Frames</th>
                    <th className="px-2 py-1 font-normal">Labeled</th>
                  </tr>
                </thead>
                <tbody>
                  {sequences.map((sequence) => (
                    <tr key={sequence.id} className="border-b border-gray-900">
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          aria-label={`Select ${sequence.name}`}
                          checked={selectedSequenceIds.has(sequence.id)}
                          onChange={() => toggleSequence(sequence.id)}
                        />
                      </td>
                      <td className="px-2 py-1">{sequence.name}</td>
                      <td className="px-2 py-1">{sequence.frame_count}</td>
                      <td className="px-2 py-1">{sequence.labeled_frame_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded border border-gray-800 bg-gray-900 p-4">
            <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
              <label className="flex flex-col gap-1">
                <span>Name</span>
                <input
                  type="text"
                  className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Train %</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="w-20 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
                  value={trainPercent}
                  onChange={(e) => setTrainPercent(Number(e.target.value))}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Val %</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="w-20 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-100"
                  value={valPercent}
                  onChange={(e) => setValPercent(Number(e.target.value))}
                />
              </label>
              <div className="flex flex-col gap-1">
                <span>Test %</span>
                <span data-testid="test-remainder" className="px-2 py-1 text-gray-300">
                  {testPercent}
                </span>
              </div>
              <button
                type="button"
                className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
                disabled={!canSave}
                aria-describedby={describedByIds.length > 0 ? describedByIds.join(" ") : undefined}
                onClick={handleSave}
              >
                Save dataset
              </button>
            </div>
            {splitExceeds100 && (
              <p id="split-exceeds-100-message" role="alert" className="text-xs text-amber-400">
                Train % and Val % must not exceed 100 combined.
              </p>
            )}
            {noSequencesSelected && (
              <p id="no-sequences-selected-message" className="text-xs text-gray-500">
                Select at least one sequence to save a dataset.
              </p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto rounded border border-gray-800 bg-gray-900 p-4">
            <DatasetsTable
              datasets={datasets}
              onDelete={(datasetId) => deleteDataset.mutate(datasetId)}
            />
          </div>
        </div>

        <div className="overflow-y-auto rounded border border-gray-800 bg-gray-900 p-4">
          {balanceQuery.data ? (
            <BalancePanel
              report={balanceQuery.data}
              collapsed={collapsed}
              excluded={excluded}
              onToggleCollapse={toggleCollapse}
              onToggleExclude={toggleExclude}
              collapsibleLabelIds={collapsibleLabelIds}
              excludedLabels={excludedLabels}
              parentLabelIdByChildId={parentLabelIdByChildId}
              labelNamesById={labelNamesById}
            />
          ) : (
            <p className="text-sm text-gray-500">
              Select sequences to see the class balance.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

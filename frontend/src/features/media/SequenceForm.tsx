import { useEffect, useState } from "react";

import { useProcedures } from "../../entities/useProcedures";
import { useDeleteSequence } from "../../entities/useMediaLibrary";
import { useCreateSequenceFromVideo, useUpdateSequence } from "../../entities/useSequences";
import { useSuggestSequenceName } from "../../entities/useSuggestSequenceName";
import type { components } from "../../shared/api/generated/schema";
import { CropFields, ZERO_CROP, type Crop } from "./CropFields";
import { SequenceStatsPanel } from "./SequenceStatsPanel";

type SequenceRead = components["schemas"]["SequenceRead"];

function mostRecentCrop(sequences: SequenceRead[]): Crop {
  const mostRecent = [...sequences].sort((a, b) => b.id - a.id)[0];
  return (mostRecent?.crop_box as Crop | null | undefined) ?? ZERO_CROP;
}

export function SequenceForm({
  sequence,
  videoId,
  markStart,
  markEnd,
  procedureId: procedureIdProp,
  existingSequences,
  onCropChange,
  onDone,
}: {
  sequence?: SequenceRead;
  videoId: number;
  markStart: number;
  markEnd: number;
  procedureId?: number;
  existingSequences: SequenceRead[];
  onCropChange: (crop: Crop) => void;
  onDone: () => void;
}) {
  const proceduresQuery = useProcedures();
  const isEdit = sequence !== undefined;

  const [procedureId, setProcedureId] = useState<number | undefined>(
    isEdit ? (sequence!.procedure_id ?? undefined) : procedureIdProp
  );
  const suggestedNameQuery = useSuggestSequenceName(isEdit ? undefined : procedureId);
  const [name, setName] = useState(isEdit ? sequence!.name : "");
  const [fps, setFps] = useState<number | "">(isEdit ? "" : 1);
  const [crop, setCrop] = useState<Crop>(() =>
    isEdit ? ((sequence!.crop_box as Crop | null) ?? ZERO_CROP) : mostRecentCrop(existingSequences)
  );
  const [confirming, setConfirming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteSequence = useDeleteSequence();
  const createSequence = useCreateSequenceFromVideo();
  const updateSequence = useUpdateSequence();
  const isPending = isEdit ? updateSequence.isPending : createSequence.isPending;
  const isError = isEdit ? updateSequence.isError : createSequence.isError;

  useEffect(() => {
    onCropChange(crop);
  }, [crop, onCropChange]);

  useEffect(() => {
    if (
      !isEdit &&
      procedureIdProp === undefined &&
      procedureId === undefined &&
      proceduresQuery.data &&
      proceduresQuery.data.length > 0
    ) {
      setProcedureId(proceduresQuery.data[0].id);
    }
  }, [isEdit, procedureIdProp, procedureId, proceduresQuery.data]);

  useEffect(() => {
    if (!isEdit && suggestedNameQuery.data?.name) {
      setName(suggestedNameQuery.data.name);
    }
  }, [isEdit, suggestedNameQuery.data?.name]);

  const startTime = Math.round(Math.min(markStart, markEnd));
  const duration = Math.round(Math.abs(markEnd - markStart));

  function handleCreateSubmit(event: React.FormEvent) {
    event.preventDefault();
    createSequence.mutate(
      { videoId, name, procedureId, startTime, duration, fps: fps === "" ? 1 : fps, crop },
      { onSuccess: () => onDone() }
    );
  }

  const rangeChanged = isEdit && (startTime !== sequence!.start_time || duration !== sequence!.duration);
  const cropChanged =
    isEdit && JSON.stringify(crop) !== JSON.stringify((sequence!.crop_box as Crop | null) ?? ZERO_CROP);
  const needsRecut = rangeChanged || cropChanged;

  function handleEditSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (needsRecut) {
      setConfirming(true);
      return;
    }
    updateSequence.mutate(
      { sequenceId: sequence!.id, name, procedureId },
      { onSuccess: () => onDone() }
    );
  }

  function handleConfirm() {
    if (fps === "") return;
    updateSequence.mutate(
      { sequenceId: sequence!.id, name, procedureId, startTime, duration, fps, crop },
      {
        onSuccess: () => onDone(),
        onError: () => setConfirming(false),
      }
    );
  }

  function handleDeleteConfirm() {
    setDeleteError(null);
    deleteSequence.mutate(sequence!.id, {
      onSuccess: () => onDone(),
      onError: (error: unknown) => {
        const detail = (error as { detail?: string } | undefined)?.detail ?? "Delete failed";
        setDeleteError(detail);
        setConfirmingDelete(false);
      },
    });
  }

  if (isEdit) {
    return (
      <div className="flex gap-3">
        <form onSubmit={handleEditSubmit} className="flex flex-1 flex-col gap-2 rounded border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-end gap-3">
            <CropFields crop={crop} onChange={setCrop} />
            <label className="flex w-16 flex-col gap-1 text-sm text-gray-300">
              FPS
              <input
                type="number"
                value={fps}
                onChange={(e) => setFps(e.target.value === "" ? "" : Number(e.target.value))}
                className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
              />
            </label>
          </div>
          <p className="text-sm text-gray-400">
            Range: {startTime}s – {startTime + duration}s ({duration}s)
          </p>
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Procedure
            <select
              value={procedureId ?? ""}
              onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : undefined)}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
            >
              <option value="">None</option>
              {(proceduresQuery.data ?? []).map((procedure) => (
                <option key={procedure.id} value={procedure.id}>
                  {procedure.name}
                </option>
              ))}
            </select>
          </label>
          {confirming && sequence!.annotation_count > 0 && (
            <p className="text-xs text-red-400">
              This will delete {sequence!.annotation_count} annotation{sequence!.annotation_count === 1 ? "" : "s"} on
              this sequence&apos;s current frames.
            </p>
          )}
          {isError && <p className="text-xs text-red-400">Save failed. Please try again.</p>}
          {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
          <div className="flex items-center justify-between gap-2">
            {!confirming ? (
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isPending || (needsRecut && fps === "")}
                  className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onDone}
                  className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                >
                  Close
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={isPending}
                  className="rounded bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-600 disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                >
                  Cancel
                </button>
              </div>
            )}
            {!confirming &&
              (!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                >
                  Delete
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDeleteConfirm}
                    disabled={deleteSequence.isPending}
                    className="rounded bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    Delete confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              ))}
          </div>
        </form>
        <div className="w-48 shrink-0 rounded border border-gray-800 bg-gray-900 p-3">
          <SequenceStatsPanel sequenceId={sequence!.id} />
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleCreateSubmit} className="flex flex-col gap-2 rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-end gap-3">
        <CropFields crop={crop} onChange={setCrop} />
        <label className="flex w-16 flex-col gap-1 text-sm text-gray-300">
          FPS
          <input
            type="number"
            value={fps === "" ? 1 : fps}
            onChange={(e) => setFps(Number(e.target.value))}
            className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
          />
        </label>
      </div>
      <p className="text-sm text-gray-400">
        Range: {startTime}s – {startTime + duration}s ({duration}s)
      </p>
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Name
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
          required
        />
      </label>
      <div className="flex flex-col gap-1 text-sm text-gray-300">
        Procedure
        <p className="text-sm text-gray-100">
          {proceduresQuery.data?.find((procedure) => procedure.id === procedureId)?.name ?? "—"}
        </p>
      </div>
      {isError && <p className="text-xs text-red-400">Failed to create sequence. Please try again.</p>}
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {isPending ? "Creating…" : "Create sequence"}
      </button>
    </form>
  );
}

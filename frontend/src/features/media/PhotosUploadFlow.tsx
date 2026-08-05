import { useEffect, useState } from "react";

import { useProcedures } from "../../entities/useProcedures";
import { useCreatePhotoSequence } from "../../entities/useSequences";
import { useSuggestSequenceName } from "../../entities/useSuggestSequenceName";

export function PhotosUploadFlow({ onCreated }: { onCreated: (sequenceId: number) => void }) {
  const proceduresQuery = useProcedures();
  const [procedureId, setProcedureId] = useState<number | undefined>(undefined);
  const suggestedNameQuery = useSuggestSequenceName(procedureId);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const createPhotoSequence = useCreatePhotoSequence();

  useEffect(() => {
    if (suggestedNameQuery.data?.name) {
      setName(suggestedNameQuery.data.name);
    }
  }, [suggestedNameQuery.data?.name]);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  function handleFilesSelected(selected: FileList | null) {
    setFiles(selected ? Array.from(selected) : []);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!procedureId || files.length === 0 || !name.trim()) return;
    setError(null);
    createPhotoSequence.mutate(
      { files, name, procedureId },
      {
        onSuccess: (sequence) => {
          if (sequence) onCreated(sequence.id);
        },
        onError: (mutationError: unknown) => {
          const detail =
            (mutationError as { detail?: string } | undefined)?.detail ?? "Upload failed";
          setError(detail);
        },
      }
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="text-sm font-semibold text-gray-200">Upload photos</h2>
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Choose photos
        <input
          type="file"
          accept="image/*"
          multiple
          aria-label="Choose photos"
          onChange={(e) => handleFilesSelected(e.target.files)}
          className="text-sm text-gray-300"
        />
      </label>
      {previewUrls.length > 0 && (
        <div className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto sm:grid-cols-8">
          {previewUrls.map((url, index) => (
            <img
              key={url}
              src={url}
              alt={`preview ${index}`}
              className="aspect-square w-full rounded object-cover"
            />
          ))}
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Procedure
        <select
          value={procedureId ?? ""}
          onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
          required
        >
          <option value="" disabled>
            Select a procedure
          </option>
          {(proceduresQuery.data ?? []).map((procedure) => (
            <option key={procedure.id} value={procedure.id}>
              {procedure.name}
            </option>
          ))}
        </select>
      </label>
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
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500"
      >
        Create sequence
      </button>
    </form>
  );
}

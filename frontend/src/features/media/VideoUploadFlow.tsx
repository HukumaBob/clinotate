import { useState } from "react";

import { useUploadVideo } from "../../entities/useVideos";
import { useProcedures } from "../../entities/useProcedures";
import { ExtractSequenceForm } from "./ExtractSequenceForm";

export function VideoUploadFlow({ onSequenceCreated }: { onSequenceCreated: (sequenceId: number) => void }) {
  const proceduresQuery = useProcedures();
  const [title, setTitle] = useState("");
  const [procedureId, setProcedureId] = useState<number | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const uploadVideo = useUploadVideo();
  const [uploadedVideoId, setUploadedVideoId] = useState<number | null>(null);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    uploadVideo.mutate(
      { file, title, procedureId },
      { onSuccess: (video) => video && setUploadedVideoId(video.id) }
    );
  }

  if (uploadedVideoId !== null) {
    return <ExtractSequenceForm videoId={uploadedVideoId} onCreated={onSequenceCreated} />;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Title
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Procedure
        <select
          value={procedureId ?? ""}
          onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
        >
          <option value="">None</option>
          {(proceduresQuery.data ?? []).map((procedure) => (
            <option key={procedure.id} value={procedure.id}>
              {procedure.name}
            </option>
          ))}
        </select>
      </label>
      <input
        type="file"
        accept="video/*"
        aria-label="Choose video"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-gray-300"
        required
      />
      <button
        type="submit"
        className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
      >
        Upload video
      </button>
    </form>
  );
}

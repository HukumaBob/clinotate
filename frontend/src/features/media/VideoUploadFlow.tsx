import { useState } from "react";

import { useUploadVideo } from "../../entities/useVideos";
import { useProcedures } from "../../entities/useProcedures";

export function VideoUploadFlow({ onVideoUploaded }: { onVideoUploaded: (videoId: number) => void }) {
  const proceduresQuery = useProcedures();
  const [title, setTitle] = useState("");
  const [procedureId, setProcedureId] = useState<number | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const uploadVideo = useUploadVideo();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    uploadVideo.mutate(
      { file, title, procedureId },
      { onSuccess: (video) => video && onVideoUploaded(video.id) }
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <h2 className="text-sm font-semibold text-gray-200">Upload video</h2>
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Title
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
      <input
        type="file"
        accept="video/*"
        aria-label="Choose video"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-sm text-gray-300"
        required
      />
      <button
        type="submit"
        className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500"
      >
        Upload video
      </button>
    </form>
  );
}

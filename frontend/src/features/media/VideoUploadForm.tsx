import { useState, type FormEvent } from "react";

import { useUploadVideo } from "../../entities/useVideos";

export function VideoUploadForm() {
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const uploadVideo = useUploadVideo();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    uploadVideo.mutate({ file, title });
    setTitle("");
    setFile(null);
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-3">
      <input
        type="text"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
        required
      />
      <input
        type="file"
        accept="video/*"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-gray-300"
        required
      />
      <button
        type="submit"
        className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
      >
        Upload
      </button>
    </form>
  );
}

import { useVideos } from "../../entities/useVideos";
import { VideoUploadForm } from "./VideoUploadForm";

export function VideoListPage() {
  const videosQuery = useVideos();

  return (
    <div className="min-h-screen bg-gray-950 p-8 text-gray-100">
      <h1 className="mb-4 text-xl font-semibold">Videos</h1>
      <div className="mb-6">
        <VideoUploadForm />
      </div>
      <ul className="space-y-2">
        {(videosQuery.data ?? []).map((video) => (
          <li key={video.id} className="rounded border border-gray-800 bg-gray-900 p-3">
            {video.title} — {video.duration_seconds.toFixed(1)}s
          </li>
        ))}
      </ul>
    </div>
  );
}

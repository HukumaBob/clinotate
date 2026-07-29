import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { MediaLibraryTable } from "./MediaLibraryTable";
import { PhotosUploadFlow } from "./PhotosUploadFlow";
import { VideoReviewPlayer } from "./VideoReviewPlayer";
import { VideoUploadFlow } from "./VideoUploadFlow";

export function MediaPage() {
  const navigate = useNavigate();
  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);

  function goToSequence(sequenceId: number) {
    navigate(`/sequences/${sequenceId}`);
  }

  return (
    <div className="min-h-screen bg-gray-950 p-8 text-gray-100">
      <h1 className="mb-6 text-xl font-semibold">Media</h1>
      <div className="mb-8">
        {selectedVideoId !== null ? (
          <VideoReviewPlayer
            videoId={selectedVideoId}
            onBack={() => setSelectedVideoId(null)}
            onOpenSequence={goToSequence}
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <VideoUploadFlow onSequenceCreated={goToSequence} />
            <PhotosUploadFlow onCreated={goToSequence} />
          </div>
        )}
      </div>
      <MediaLibraryTable onSelectVideo={setSelectedVideoId} />
    </div>
  );
}

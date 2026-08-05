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
    <div className="flex h-screen flex-col overflow-hidden bg-gray-950 text-gray-100">
      <div className="shrink-0 px-8 pt-8">
        {selectedVideoId !== null ? (
          <VideoReviewPlayer
            videoId={selectedVideoId}
            onBack={() => setSelectedVideoId(null)}
            onOpenSequence={goToSequence}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <VideoUploadFlow onVideoUploaded={setSelectedVideoId} />
            <PhotosUploadFlow onCreated={goToSequence} />
          </div>
        )}
      </div>
      <div className="mt-6 flex-1 overflow-y-auto px-8 pb-8">
        <MediaLibraryTable onSelectVideo={setSelectedVideoId} />
      </div>
    </div>
  );
}

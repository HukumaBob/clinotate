import { useNavigate } from "react-router-dom";

import { MediaLibraryTable } from "./MediaLibraryTable";
import { PhotosUploadFlow } from "./PhotosUploadFlow";
import { VideoUploadFlow } from "./VideoUploadFlow";

export function MediaPage() {
  const navigate = useNavigate();

  function goToSequence(sequenceId: number) {
    navigate(`/sequences/${sequenceId}`);
  }

  return (
    <div className="min-h-screen bg-gray-950 p-8 text-gray-100">
      <h1 className="mb-6 text-xl font-semibold">Media</h1>
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <VideoUploadFlow onSequenceCreated={goToSequence} />
        <PhotosUploadFlow onCreated={goToSequence} />
      </div>
      <MediaLibraryTable />
    </div>
  );
}

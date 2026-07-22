import { Link } from "react-router-dom";

import { useFrames } from "../../entities/useFrames";

export function FrameGrid({ sequenceId }: { sequenceId: number }) {
  const framesQuery = useFrames(sequenceId);

  return (
    <div className="grid grid-cols-4 gap-2">
      {(framesQuery.data ?? []).map((frame) => (
        <Link
          key={frame.id}
          to={`/frames/${frame.id}`}
          className="rounded border border-gray-800 bg-gray-900 p-2 text-center text-sm text-gray-300 hover:border-blue-500"
        >
          Frame {frame.frame_index}
        </Link>
      ))}
    </div>
  );
}

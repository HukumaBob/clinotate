import { useEffect, useState } from "react";

import { useJob } from "../../entities/useJobs";
import { useTranscodeVideo } from "../../entities/useVideo";

export function TranscodePrompt({
  videoId,
  onTranscodeComplete,
}: {
  videoId: number;
  onTranscodeComplete: () => void;
}) {
  const [jobId, setJobId] = useState<number | null>(null);
  const transcode = useTranscodeVideo();
  const jobQuery = useJob(jobId);

  useEffect(() => {
    if (jobQuery.data?.status === "succeeded") {
      onTranscodeComplete();
    }
  }, [jobQuery.data?.status, jobQuery.data?.id, onTranscodeComplete]);

  function handleClick() {
    transcode.mutate(videoId, {
      onSuccess: (job) => {
        if (job) setJobId(job.id);
      },
    });
  }

  const status = jobQuery.data?.status;

  return (
    <div className="flex flex-col items-center gap-3 rounded border border-gray-800 bg-gray-900 p-8 text-center text-gray-300">
      <p>This video&apos;s format isn&apos;t supported by the browser player.</p>
      {status === "pending" || status === "running" ? (
        <p className="text-sm text-gray-400">
          {jobQuery.data && jobQuery.data.progress >= 0
            ? `Converting… ${jobQuery.data.progress}%`
            : "Converting… this may take a while for large files"}
        </p>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500"
        >
          Convert video
        </button>
      )}
      {status === "failed" && (
        <p className="text-sm text-red-400">{jobQuery.data?.error}</p>
      )}
    </div>
  );
}

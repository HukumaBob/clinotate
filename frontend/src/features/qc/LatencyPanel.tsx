import type { Timing, TimingStats } from "./predictions";

const STAGES: { key: "preprocess_ms" | "inference_ms" | "postprocess_ms" | "total_ms"; label: string }[] = [
  { key: "preprocess_ms", label: "Preprocess" },
  { key: "inference_ms", label: "Inference" },
  { key: "postprocess_ms", label: "Postprocess" },
  { key: "total_ms", label: "Total" },
];

const fmt = (value: number) => value.toFixed(1);

export function LatencyPanel({ timing }: { timing: Timing | undefined }) {
  return (
    <section aria-label="Latency" className="flex flex-col gap-2 text-sm text-gray-300">
      <h2 className="text-sm font-semibold text-gray-200">Latency</h2>
      {timing === undefined ? (
        <p className="text-xs text-gray-500">Not recorded for this run</p>
      ) : (
        <>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-gray-500">
                <th className="font-normal">Stage (ms)</th>
                <th className="text-right font-normal">mean</th>
                <th className="text-right font-normal">p50</th>
                <th className="text-right font-normal">p95</th>
                <th className="text-right font-normal">max</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map(({ key, label }) => {
                const stats: TimingStats = timing[key];
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td className="text-right">{fmt(stats.mean)}</td>
                    <td className="text-right">{fmt(stats.p50)}</td>
                    <td className="text-right">{fmt(stats.p95)}</td>
                    <td className="text-right">{fmt(stats.max)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-gray-400">
            Model speed: {timing.model_fps} fps ({timing.frames_measured} frames measured)
          </p>
        </>
      )}
    </section>
  );
}

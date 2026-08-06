const BYTES_PER_GIB = 1024 ** 3;

interface VramGaugeProps {
  vramUsedBytes: number | null;
  vramTotalBytes: number | null;
  isLive: boolean;
}

function thresholdColorClass(usedBytes: number, totalBytes: number): string {
  const ratio = usedBytes / totalBytes;
  if (ratio > 0.85) return "bg-red-500";
  if (ratio > 0.6) return "bg-yellow-500";
  return "bg-green-500";
}

export function VramGauge({ vramUsedBytes, vramTotalBytes, isLive }: VramGaugeProps) {
  const hasData = vramUsedBytes !== null && vramTotalBytes !== null;

  return (
    <div
      data-testid="vram-gauge"
      className={`flex items-center gap-2 text-xs text-gray-400 ${!isLive && hasData ? "opacity-50" : ""}`}
    >
      {!hasData ? (
        <span>No data yet</span>
      ) : (
        <>
          <span
            data-testid="vram-gauge-dot"
            className={`h-2 w-2 rounded-full ${thresholdColorClass(vramUsedBytes, vramTotalBytes)}`}
          />
          <span>
            {(vramUsedBytes / BYTES_PER_GIB).toFixed(1)} / {(vramTotalBytes / BYTES_PER_GIB).toFixed(1)} GiB
          </span>
        </>
      )}
    </div>
  );
}

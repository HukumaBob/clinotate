import { useSequenceStats } from "../../entities/useSequenceStats";

export function SequenceStatsPanel({ sequenceId }: { sequenceId: number }) {
  const statsQuery = useSequenceStats(sequenceId);
  const stats = statsQuery.data;

  if (!stats) return null;

  const summaryLine =
    stats.frame_width !== null && stats.frame_height !== null
      ? `${stats.frame_count} frames · ${stats.frame_width}×${stats.frame_height}`
      : `${stats.frame_count} frames`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-gray-400">{summaryLine}</p>
      <p className="text-sm font-semibold text-gray-200">Labels</p>
      {stats.labels.length === 0 ? (
        <p className="text-xs text-gray-400">No annotations yet</p>
      ) : (
        <div className="max-h-32 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {stats.labels.map((label) => (
                <tr key={label.label_name}>
                  <td className="py-1 px-2 text-gray-100">{label.label_name}</td>
                  <td className="py-1 px-2 text-right text-gray-100">{label.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

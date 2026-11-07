import type { components } from "../../shared/api/generated/schema";

type SplitReportRead = components["schemas"]["SplitReportRead"];

interface SplitWarningsProps {
  report: SplitReportRead | null | undefined;
}

/** The warnings of a dataset's split, folded into one line so a bad split is
 * seen when a dataset is picked for training, before a run starts. */
export function SplitWarnings({ report }: SplitWarningsProps) {
  const warnings = report?.warnings ?? [];
  if (warnings.length === 0) {
    return null;
  }
  return (
    <details className="relative">
      <summary className="cursor-pointer select-none text-amber-400 hover:text-amber-300">
        {`${warnings.length} split ${warnings.length === 1 ? "warning" : "warnings"}`}
      </summary>
      <ul className="absolute left-0 z-10 mt-1 flex min-w-72 max-w-md flex-col gap-1 rounded border border-gray-700 bg-gray-900 p-3 text-[13px] text-amber-300 shadow-lg">
        {warnings.map((warning) => (
          <li key={`${warning.kind}-${warning.label_id ?? "all"}-${warning.split ?? "all"}`}>{warning.message}</li>
        ))}
      </ul>
    </details>
  );
}

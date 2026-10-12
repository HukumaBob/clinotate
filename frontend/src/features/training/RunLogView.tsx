import type { components } from "../../shared/api/generated/schema";
import { LogView } from "./LogView";
import { isActiveRun } from "./runLogic";
import { useRunLog } from "./useRunLog";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface RunLogViewProps {
  run: TrainingRunRead;
}

export function RunLogView({ run }: RunLogViewProps) {
  const { text, error } = useRunLog(run.id, isActiveRun(run));

  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <p className="mb-3 text-xs text-gray-400">
        Cleaned view of the trainer's output; the stored log is kept raw.
      </p>
      {error && <p className="mb-2 text-sm text-red-400">Failed to load the log.</p>}
      {/* Keyed by run so another run starts with a fresh pane and scroll position;
          the max height makes only the log scroll while the page scrolls as a unit. */}
      <LogView key={run.id} text={text} className="max-h-[70vh]" />
    </section>
  );
}

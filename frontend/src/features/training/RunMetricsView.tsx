import type { components } from "../../shared/api/generated/schema";
import { ConfusionMatrix } from "./ConfusionMatrix";
import { MetricsChart } from "./MetricsChart";
import { PerClassTable } from "./PerClassTable";
import { isActiveRun } from "./runLogic";
import { useRunMetrics } from "./useRunMetrics";

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

interface RunMetricsViewProps {
  run: TrainingRunRead;
}

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-[15px] font-semibold text-gray-200">{title}</h3>
      <p className="mb-3 text-[13px] text-gray-400">{caption}</p>
      {children}
    </section>
  );
}

/** Everything here comes from the run itself, so it stays complete after the
 * run's model has been deleted. */
export function RunMetricsView({ run }: RunMetricsViewProps) {
  const { data, error, loading } = useRunMetrics(run.id, isActiveRun(run), run.current_epoch);

  if (error && !data) {
    return <p className="text-sm text-gray-400">Failed to load the run's metrics.</p>;
  }
  if (!data) {
    return loading ? <p className="text-sm text-gray-400">Loading…</p> : null;
  }

  const history = (data.history ?? []) as Array<Record<string, number>>;
  const perClass = (data.per_class ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="flex flex-col gap-4">
      {history.length > 0 && (
        <Section title="Training curve" caption="Loss and metrics after each epoch.">
          <div className="min-h-[280px] max-w-full">
            <MetricsChart history={history} />
          </div>
        </Section>
      )}

      <Section
        title="Confusion matrix"
        caption="How often each true class was predicted as each class."
      >
        {data.confusion ? (
          <ConfusionMatrix
            confusion={data.confusion as unknown as { labels: string[]; matrix: number[][] }}
          />
        ) : (
          <p className="text-sm text-gray-400">No confusion matrix for this run.</p>
        )}
      </Section>

      <Section title="Per-class metrics" caption="Final scores for each class; click a column to sort.">
        {perClass.length > 0 ? (
          <PerClassTable rows={perClass} />
        ) : (
          <p className="text-sm text-gray-400">No per-class metrics for this run.</p>
        )}
      </Section>
    </div>
  );
}

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

export type TrainTab = "runs" | "new";
export type RunView = "overview" | "metrics" | "log" | "model";

export interface TrainUrlState {
  dataset: number | null;
  tab: TrainTab;
  run: number | null;
  view: RunView;
}

const TABS: TrainTab[] = ["runs", "new"];
const VIEWS: RunView[] = ["overview", "metrics", "log", "model"];

function positiveInt(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number > 0 ? number : null;
}

export function useTrainUrl(): [
  TrainUrlState,
  (patch: Partial<TrainUrlState>, options?: { replace?: boolean }) => void,
] {
  const [params, setParams] = useSearchParams();

  const state = useMemo<TrainUrlState>(() => {
    const tab = params.get("tab");
    const view = params.get("view");
    return {
      dataset: positiveInt(params.get("dataset")),
      tab: TABS.includes(tab as TrainTab) ? (tab as TrainTab) : "runs",
      run: positiveInt(params.get("run")),
      view: VIEWS.includes(view as RunView) ? (view as RunView) : "overview",
    };
  }, [params]);

  const update = useCallback(
    (patch: Partial<TrainUrlState>, options: { replace?: boolean } = {}) => {
      // A run belongs to one dataset: switching dataset drops the selected run.
      const next: TrainUrlState = {
        ...state,
        ...patch,
        ...(patch.dataset !== undefined && patch.dataset !== state.dataset && patch.run === undefined
          ? { run: null, view: "overview" as RunView }
          : {}),
      };
      const search = new URLSearchParams();
      if (next.dataset !== null) search.set("dataset", String(next.dataset));
      if (next.tab !== "runs") search.set("tab", next.tab);
      if (next.run !== null) search.set("run", String(next.run));
      if (next.view !== "overview") search.set("view", next.view);
      setParams(search, { replace: options.replace ?? false });
    },
    [state, setParams],
  );

  return [state, update];
}

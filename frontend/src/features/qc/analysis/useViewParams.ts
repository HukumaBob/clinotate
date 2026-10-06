import { useCallback, useState } from "react";

import { clampParams, loadParams, saveParams } from "./params";
import { DEFAULT_VIEW_PARAMS, type ViewParams } from "./view";

/** The display parameters, remembered per browser (not per run) as a
 * convenience. Every value is clamped before it is kept. */
export function useViewParams(): [ViewParams, (next: ViewParams) => void, () => void] {
  const [params, setParams] = useState<ViewParams>(() => loadParams());

  const update = useCallback((next: ViewParams) => {
    const clamped = clampParams(next);
    setParams(clamped);
    saveParams(clamped);
  }, []);

  const reset = useCallback(() => {
    const defaults = { ...DEFAULT_VIEW_PARAMS };
    setParams(defaults);
    saveParams(defaults);
  }, []);

  return [params, update, reset];
}

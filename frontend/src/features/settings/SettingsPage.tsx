import { useEffect, useRef, useState } from "react";

import { useSettings, useUpdateSettings } from "../../entities/useSettings";
import { errorDetail } from "../../shared/api/errors";

export function SettingsPage() {
  const settingsQuery = useSettings();
  const updateSettings = useUpdateSettings();
  const [maxTrackRangeFrames, setMaxTrackRangeFrames] = useState<number | "">("");
  const [maskPostprocessStrength, setMaskPostprocessStrength] = useState<number | "">("");
  const [minMaskAreaFraction, setMinMaskAreaFraction] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const hasInitializedField = useRef(false);

  useEffect(() => {
    // Only seed the fields from the server once. Re-running this on every
    // `settingsQuery.data` change (e.g. the refetch after a successful save,
    // or a slow initial GET resolving mid-edit) would clobber whatever the
    // user is actively typing.
    if (settingsQuery.data && !hasInitializedField.current) {
      hasInitializedField.current = true;
      setMaxTrackRangeFrames(settingsQuery.data.max_track_range_frames);
      setMaskPostprocessStrength(settingsQuery.data.mask_postprocess_strength);
      setMinMaskAreaFraction(settingsQuery.data.min_mask_area_fraction);
    }
  }, [settingsQuery.data]);

  if (!settingsQuery.data) {
    return (
      <div className="mx-auto max-w-xl p-6 text-gray-100">
        <h1 className="mb-6 text-xl font-semibold">Settings</h1>
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (maxTrackRangeFrames === "" || maskPostprocessStrength === "" || minMaskAreaFraction === "")
      return;
    setError(null);
    updateSettings.mutate(
      { maxTrackRangeFrames, maskPostprocessStrength, minMaskAreaFraction },
      {
        onError: (mutationError: unknown) => {
          setError(errorDetail(mutationError, "Save failed"));
        },
      }
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6 text-gray-100">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      <section className="mb-4 rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-300">GPU / Performance</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Max SAM2 tracking range (combined frames)
            <input
              type="number"
              min={1}
              value={maxTrackRangeFrames}
              onChange={(event) =>
                setMaxTrackRangeFrames(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="w-32 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
          </label>
          <p className="text-xs text-gray-500">
            This GPU has a known VRAM stability issue at larger tracking ranges. Lower is safer.
          </p>

          <h2 className="mb-3 mt-4 text-sm font-medium text-gray-300">Mask post-processing</h2>
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Default mask smoothing strength (0–1)
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={maskPostprocessStrength}
              onChange={(event) =>
                setMaskPostprocessStrength(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="w-32 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
          </label>
          <p className="text-xs text-gray-500">
            Applied automatically to new SAM2 masks unless overridden in the frame editor. 0 disables
            cleanup entirely.
          </p>

          <h2 className="mb-3 mt-4 text-sm font-medium text-gray-300">Dataset export</h2>
          <label className="flex flex-col gap-1 text-sm text-gray-300">
            Minimum mask area (fraction of frame)
            <input
              type="number"
              min={0}
              max={1}
              step={0.0001}
              value={minMaskAreaFraction}
              onChange={(event) =>
                setMinMaskAreaFraction(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="w-32 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
          </label>
          <p className="text-xs text-gray-500">
            Masks smaller than this fraction of their frame&apos;s area are dropped from dataset
            exports as noise.
          </p>

          <button
            type="submit"
            disabled={
              maxTrackRangeFrames === "" || maskPostprocessStrength === "" || minMaskAreaFraction === ""
            }
            className="mt-2 w-fit rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>
      </section>
    </div>
  );
}

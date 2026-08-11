import { useEffect, useRef, useState } from "react";

import { useSettings, useUpdateSettings } from "../../entities/useSettings";

export function SettingsPage() {
  const settingsQuery = useSettings();
  const updateSettings = useUpdateSettings();
  const [maxTrackRangeFrames, setMaxTrackRangeFrames] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const hasInitializedField = useRef(false);

  useEffect(() => {
    // Only seed the field from the server once. Re-running this on every
    // `settingsQuery.data` change (e.g. the refetch after a successful save,
    // or a slow initial GET resolving mid-edit) would clobber whatever the
    // user is actively typing.
    if (settingsQuery.data && !hasInitializedField.current) {
      hasInitializedField.current = true;
      setMaxTrackRangeFrames(settingsQuery.data.max_track_range_frames);
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
    if (maxTrackRangeFrames === "") return;
    setError(null);
    updateSettings.mutate(
      { maxTrackRangeFrames },
      {
        onError: (mutationError: unknown) => {
          const detail =
            (mutationError as { detail?: string } | undefined)?.detail ?? "Save failed";
          setError(detail);
        },
      }
    );
  }

  return (
    <div className="mx-auto max-w-xl p-6 text-gray-100">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      <section className="rounded border border-gray-800 bg-gray-900 p-4">
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
          <button
            type="submit"
            disabled={maxTrackRangeFrames === ""}
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

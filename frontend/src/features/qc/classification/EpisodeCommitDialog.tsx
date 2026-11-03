import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { type CommitEpisodesRead, useCommitEpisodes } from "../../../entities/useCommitEpisodes";
import { useVideoSent } from "../../../entities/useQcFlags";
import { toRequestEpisodes } from "./episodeSelection";

export interface EpisodeCommitDialogProps {
  runId: number;
  videoId: number;
  /** Selected episode keys (`axis|start_ms`). */
  keys: string[];
  referenceStatus?: string | null;
  onClose: () => void;
  /** Called once when the real commit succeeded. */
  onCommitted?: () => void;
}

const PREVIEW_DEBOUNCE_MS = 400;

/** Seconds text to milliseconds, or null when empty or outside [min, max]. */
function parseSeconds(text: string, min: number, max: number): number | null {
  if (text.trim() === "") return null;
  const s = Number(text);
  if (!Number.isFinite(s) || s < min || s > max) return null;
  return Math.round(s * 1000);
}

function errorText(error: unknown, fallback: string): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : fallback;
}

const field = "w-20 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right text-gray-100";

export function EpisodeCommitDialog({
  runId,
  videoId,
  keys,
  referenceStatus,
  onClose,
  onCommitted,
}: EpisodeCommitDialogProps) {
  const [name, setName] = useState("");
  const [step, setStep] = useState("1");
  const [margin, setMargin] = useState("1");
  const [preview, setPreview] = useState<CommitEpisodesRead | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CommitEpisodesRead | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const { mutate } = useCommitEpisodes(runId, videoId);
  const sent = useVideoSent(videoId).data;

  const stepMs = parseSeconds(step, 0.1, 60);
  const marginMs = parseSeconds(margin, 0, 60);
  const valid = stepMs !== null && marginMs !== null;
  const keyList = keys.join("\n");

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  // Live preview: only the latest request's answer is shown.
  const latest = useRef(0);
  useEffect(() => {
    const id = ++latest.current;
    setPreview(null);
    setPreviewError(null);
    if (stepMs === null || marginMs === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      mutate(
        {
          episodes: toRequestEpisodes(keyList === "" ? [] : keyList.split("\n")),
          stepMs,
          marginMs,
          name: null,
          dryRun: true,
        },
        {
          onSuccess: (data) => {
            if (id !== latest.current) return;
            setPreview(data);
            setLoading(false);
          },
          onError: (error) => {
            if (id !== latest.current) return;
            setPreviewError(errorText(error, "Could not count the frames."));
            setLoading(false);
          },
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [stepMs, marginMs, keyList, mutate]);

  const canSend =
    valid && !loading && !submitting && preview !== null && !previewError && preview.frames > 0;

  const send = () => {
    if (!canSend || stepMs === null || marginMs === null) return;
    setSubmitting(true);
    setCommitError(null);
    mutate(
      {
        episodes: toRequestEpisodes(keys),
        stepMs,
        marginMs,
        name: name.trim() === "" ? null : name.trim(),
        dryRun: false,
      },
      {
        onSuccess: (data) => {
          setSubmitting(false);
          setCreated(data);
          onCommitted?.();
        },
        onError: (error) => {
          setSubmitting(false);
          setCommitError(errorText(error, "Could not send the frames."));
        },
      },
    );
  };

  const axes = preview ? Object.entries(preview.annotations_by_axis) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send frames to training"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-200"
      >
        <h2 className="mb-3 text-base font-semibold text-gray-100">Send frames to training</h2>

        {created ? (
          <div className="flex flex-col gap-3">
            <p>
              Created sequence {created.sequence_name} ({created.frames}{" "}
              {created.frames === 1 ? "frame" : "frames"})
            </p>
            <div className="flex justify-end gap-2">
              {created.sequence_id !== null && (
                <Link
                  to={`/sequences/${created.sequence_id}`}
                  className="rounded border border-blue-600 bg-blue-950 px-3 py-1 text-xs text-blue-200"
                >
                  Open sequence
                </Link>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:text-gray-100"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <label htmlFor="qc-episode-name" className="mb-1 block text-gray-300">
              Sequence name
            </label>
            <input
              id="qc-episode-name"
              ref={nameRef}
              type="text"
              maxLength={255}
              value={name}
              placeholder={`QC errors · <video> · run #${runId} · <date>`}
              onChange={(e) => setName(e.target.value)}
              className="mb-3 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-gray-100"
            />

            <div className="mb-1 flex items-center gap-4">
              <label className="flex items-center gap-2">
                <span>Step (s)</span>
                <input
                  type="number"
                  aria-label="Step (s)"
                  min={0.1}
                  max={60}
                  step={0.1}
                  value={step}
                  onChange={(e) => setStep(e.target.value)}
                  className={field}
                />
              </label>
              <label className="flex items-center gap-2">
                <span>Margin (s)</span>
                <input
                  type="number"
                  aria-label="Margin (s)"
                  min={0}
                  max={60}
                  step={0.5}
                  value={margin}
                  onChange={(e) => setMargin(e.target.value)}
                  className={field}
                />
              </label>
            </div>
            {stepMs === null && <p className="text-xs text-red-400">Step must be between 0.1 and 60 seconds.</p>}
            {marginMs === null && <p className="text-xs text-red-400">Margin must be between 0 and 60 seconds.</p>}

            <div aria-live="polite" className="my-3 rounded border border-gray-800 px-2 py-1.5 text-xs text-gray-300">
              {loading && <p>Counting frames…</p>}
              {!loading && preview && preview.frames === 0 && <p>No frames to send</p>}
              {!loading && preview && preview.frames > 0 && (
                <ul className="list-disc pl-4">
                  <li>
                    {preview.episodes} {preview.episodes === 1 ? "episode" : "episodes"}
                  </li>
                  <li>
                    {preview.frames} {preview.frames === 1 ? "frame" : "frames"}
                  </li>
                  {preview.dropped_unlabeled > 0 && (
                    <li>
                      {preview.dropped_unlabeled}{" "}
                      {preview.dropped_unlabeled === 1 ? "frame" : "frames"} dropped as unlabeled
                    </li>
                  )}
                  {axes.map(([axis, count]) => (
                    <li key={axis}>
                      {axis}: {count}
                    </li>
                  ))}
                </ul>
              )}
              {!loading && !preview && !previewError && !valid && <p>Fix the fields to see a preview.</p>}
            </div>

            {previewError && (
              <p role="alert" className="mb-3 text-xs text-red-400">
                {previewError}
              </p>
            )}

            {referenceStatus === "clean" && (
              <p className="mb-3 rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
                Once a classifier is trained on these frames, this video's reference will stop being an
                independent test.
              </p>
            )}
            {referenceStatus === "compromised" && (
              <p className="mb-3 rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
                This video's reference is already compromised: frames of it were used for training.
              </p>
            )}
            {sent && sent.frames > 0 && (
              <p className="mb-3 text-xs text-gray-400">
                {sent.frames} {sent.frames === 1 ? "frame" : "frames"} of this video{" "}
                {sent.frames === 1 ? "was" : "were"} already sent to training.
              </p>
            )}

            {commitError && (
              <p role="alert" className="mb-3 text-xs text-red-400">
                {commitError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={onClose}
                className="rounded border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSend}
                onClick={send}
                className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

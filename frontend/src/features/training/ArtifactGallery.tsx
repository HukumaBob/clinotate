import { useCallback, useEffect, useState } from "react";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";

type ArtifactRead = components["schemas"]["ArtifactRead"];

interface ArtifactGalleryProps {
  versionId: number;
  artifacts: ArtifactRead[];
}

const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

function isImage(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** The icon glyph for a non-image artifact, by extension. Trainers write
 * tabular data, configs and plain text alongside their plots; those get a
 * card too rather than being hidden, since `results.csv` is often the most
 * useful file in the directory. */
function fileGlyph(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "▦";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "⚙";
  if (lower.endsWith(".json")) return "{ }";
  return "▤";
}

export function ArtifactGallery({ versionId, artifacts }: ArtifactGalleryProps) {
  // Presigned URLs, resolved once per artifact and cached by index. The
  // download endpoint is a round-trip per file, so a grid of twelve plots
  // must not re-request on every render or every lightbox step.
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [lightbox, setLightbox] = useState<number | null>(null);

  const images = artifacts.filter((artifact) => isImage(artifact.name));
  const files = artifacts.filter((artifact) => !isImage(artifact.name));

  const resolveUrl = useCallback(
    async (index: number): Promise<string | null> => {
      const { data } = await apiClient.GET("/training/models/{version_id}/artifacts/{index}", {
        params: { path: { version_id: versionId, index } },
      });
      const url = data?.download_url ?? null;
      if (url) {
        setUrls((prev) => ({ ...prev, [index]: url }));
      }
      return url;
    },
    [versionId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const artifact of images) {
        if (cancelled) return;
        // Sequential rather than Promise.all: a run can carry a dozen plots
        // and each is a presign round-trip; firing them all at once buys
        // nothing on a local MinIO and floods the request log.
        await resolveUrl(artifact.index);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, images.map((a) => a.index).join(",")]);

  const lightboxPosition = lightbox === null ? -1 : images.findIndex((a) => a.index === lightbox);

  const step = useCallback(
    (delta: number) => {
      if (lightboxPosition < 0) return;
      const next = images[(lightboxPosition + delta + images.length) % images.length];
      if (next) setLightbox(next.index);
    },
    [images, lightboxPosition],
  );

  useEffect(() => {
    if (lightbox === null) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setLightbox(null);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "ArrowLeft") step(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, step]);

  async function download(index: number) {
    const url = urls[index] ?? (await resolveUrl(index));
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  if (artifacts.length === 0) return null;

  const active = lightbox === null ? null : artifacts.find((a) => a.index === lightbox);

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        {images.map((artifact) => (
          <button
            key={artifact.index}
            type="button"
            data-artifact-card={artifact.name}
            onClick={() => setLightbox(artifact.index)}
            className="group flex flex-col overflow-hidden rounded border border-gray-800 bg-gray-950 text-left transition hover:border-gray-600"
          >
            <div className="flex h-24 items-center justify-center overflow-hidden bg-black/40">
              {urls[artifact.index] ? (
                <img
                  src={urls[artifact.index]}
                  alt={artifact.name}
                  className="max-h-full max-w-full object-contain transition group-hover:scale-105"
                />
              ) : (
                <span className="text-[10px] text-gray-600">Loading…</span>
              )}
            </div>
            <span className="truncate px-2 py-1.5 text-[11px] text-gray-400 group-hover:text-gray-200">
              {artifact.name}
            </span>
          </button>
        ))}

        {files.map((artifact) => (
          <button
            key={artifact.index}
            type="button"
            data-artifact-card={artifact.name}
            onClick={() => download(artifact.index)}
            className="group flex flex-col overflow-hidden rounded border border-gray-800 bg-gray-950 text-left transition hover:border-gray-600"
          >
            <div className="flex h-24 items-center justify-center bg-black/40 text-2xl text-gray-700 transition group-hover:text-gray-500">
              {fileGlyph(artifact.name)}
            </div>
            <span className="truncate px-2 py-1.5 text-[11px] text-gray-400 group-hover:text-gray-200">
              {artifact.name}
            </span>
          </button>
        ))}
      </div>

      {active && (
        // Rendered inside the panel rather than in a portal: the panel is
        // already the full right column, and `fixed` positioning escapes it
        // to cover the viewport either way.
        <div
          role="dialog"
          aria-modal="true"
          aria-label={active.name}
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-6"
          onClick={() => setLightbox(null)}
        >
          <div className="mb-3 flex shrink-0 items-center justify-between text-sm text-gray-300">
            <span>
              {active.name}
              {images.length > 1 && (
                <span className="ml-2 text-gray-600">
                  {lightboxPosition + 1} / {images.length}
                </span>
              )}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
                onClick={(event) => {
                  event.stopPropagation();
                  void download(active.index);
                }}
              >
                Download
              </button>
              <button
                type="button"
                className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
                onClick={() => setLightbox(null)}
              >
                Close
              </button>
            </span>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center gap-4">
            {images.length > 1 && (
              <button
                type="button"
                aria-label="Previous artifact"
                className="shrink-0 px-3 py-6 text-2xl text-gray-600 hover:text-gray-300"
                onClick={(event) => {
                  event.stopPropagation();
                  step(-1);
                }}
              >
                ‹
              </button>
            )}
            {urls[active.index] && (
              <img
                src={urls[active.index]}
                alt={active.name}
                className="max-h-full max-w-full object-contain"
                onClick={(event) => event.stopPropagation()}
              />
            )}
            {images.length > 1 && (
              <button
                type="button"
                aria-label="Next artifact"
                className="shrink-0 px-3 py-6 text-2xl text-gray-600 hover:text-gray-300"
                onClick={(event) => {
                  event.stopPropagation();
                  step(1);
                }}
              >
                ›
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

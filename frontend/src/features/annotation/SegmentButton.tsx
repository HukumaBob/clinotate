import { useState, type MouseEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { LabelPicker } from "./LabelPicker";

type Label = components["schemas"]["LabelRead"];

interface SegmentButtonProps {
  frameId: number;
  imageUrl: string;
  labels: Label[];
  onJobCreated: (jobId: number) => void;
}

export function SegmentButton({ frameId, imageUrl, labels, onJobCreated }: SegmentButtonProps) {
  const [isPicking, setIsPicking] = useState(false);
  const [selectedLabelId, setSelectedLabelId] = useState<number | null>(null);

  const createJob = useMutation({
    mutationFn: async (coords: [number, number]) => {
      const result = await apiClient.POST("/jobs/sam3/predict", {
        body: {
          frame_id: frameId,
          label_id: selectedLabelId as number,
          prompts: [{ type: "point", coords, label: true }],
        },
      });
      return result.data;
    },
    onSuccess: (data) => {
      setIsPicking(false);
      setSelectedLabelId(null);
      if (data) {
        onJobCreated(data.id);
      }
    },
  });

  function handleImageClick(event: MouseEvent<HTMLImageElement>) {
    if (!isPicking || selectedLabelId === null || createJob.isPending) return;
    const img = event.currentTarget;
    const rect = img.getBoundingClientRect();

    // The <img> is rendered with object-contain, so its own bounding box can
    // be larger than the actual displayed picture (letterboxed to preserve
    // aspect ratio) -- normalizing against the box directly would offset
    // clicks away from the frame content they appear to land on. Compute the
    // real content rect inside the box first, using the image's natural
    // (pixel) dimensions, and normalize against that instead.
    const naturalWidth = img.naturalWidth || rect.width;
    const naturalHeight = img.naturalHeight || rect.height;
    const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
    const renderedWidth = naturalWidth * scale;
    const renderedHeight = naturalHeight * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;

    const normalizedX = (event.clientX - rect.left - offsetX) / renderedWidth;
    const normalizedY = (event.clientY - rect.top - offsetY) / renderedHeight;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    createJob.mutate([clamp(normalizedX), clamp(normalizedY)]);
  }

  function handleStart() {
    setIsPicking(true);
    setSelectedLabelId(null);
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleStart}
        className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
      >
        Segment with SAM-3
      </button>
      {isPicking && selectedLabelId === null && (
        <div className="mt-2">
          <p className="mb-2 text-sm text-gray-400">Select a label for the SAM-3 mask</p>
          <LabelPicker labels={labels} onSelect={setSelectedLabelId} />
        </div>
      )}
      {isPicking && selectedLabelId !== null && (
        <>
          <p className="mt-2 text-sm text-gray-400">
            {createJob.isPending ? "Submitting..." : "Click a point on the frame to segment"}
          </p>
          {createJob.isError && (
            <p className="mt-1 text-sm text-red-400">
              Failed to create segmentation job. Please try again.
            </p>
          )}
          {/*
            Real frame image doubles as the click surface: click coordinates are
            normalized to [0,1] fractions of the rendered image's own bounding
            box (see handleImageClick), so the backend always receives a point
            relative to the actual frame regardless of how large the browser
            renders it.
          */}
          <img
            data-testid="segment-click-target"
            src={imageUrl}
            alt="Frame to segment"
            onClick={handleImageClick}
            className="h-64 w-full max-w-md cursor-crosshair rounded border border-gray-700 bg-gray-900 object-contain"
          />
        </>
      )}
    </div>
  );
}

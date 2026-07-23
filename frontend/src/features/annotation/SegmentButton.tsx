import { useState, type MouseEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { LabelPicker } from "./LabelPicker";

type Label = components["schemas"]["LabelRead"];

interface SegmentButtonProps {
  frameId: number;
  labels: Label[];
  onJobCreated: (jobId: number) => void;
}

export function SegmentButton({ frameId, labels, onJobCreated }: SegmentButtonProps) {
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

  function handleImageClick(event: MouseEvent<HTMLDivElement>) {
    if (!isPicking || selectedLabelId === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const normalizedX = (event.clientX - rect.left) / rect.width;
    const normalizedY = (event.clientY - rect.top) / rect.height;
    createJob.mutate([normalizedX, normalizedY]);
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
          <p className="mt-2 text-sm text-gray-400">Click a point on the frame to segment</p>
          {/*
            Placeholder click surface: Task 10 replaces this with the real frame
            <img> once FrameAnnotationPage renders one. It must have a non-zero
            layout box (not display:contents) so getBoundingClientRect() below
            yields real dimensions instead of an all-zero DOMRect in a real
            browser (division by a zero width/height produced Infinity/NaN
            coords and a 422 from the backend — caught only by manual
            real-browser verification, not the mocked-rect unit test).
          */}
          <div
            data-testid="segment-click-target"
            onClick={handleImageClick}
            className="flex h-64 w-full max-w-md cursor-crosshair items-center justify-center rounded border border-dashed border-gray-700 bg-gray-900 text-xs text-gray-600"
          >
            Frame image placeholder — click to place a point
          </div>
        </>
      )}
    </div>
  );
}

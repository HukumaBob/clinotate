import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { SegmentButton } from "../src/features/annotation/SegmentButton";

const LABELS = [
  { id: 5, name: "Polyp", color: "#ff0000", taxonomy_version: 1 },
  { id: 6, name: "Ulcer", color: "#00ff00", taxonomy_version: 1 },
];

function renderButton(onJobCreated: (jobId: number) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SegmentButton
        frameId={42}
        imageUrl="https://example.test/frame-42.jpg"
        labels={LABELS as never}
        onJobCreated={onJobCreated}
      />
    </QueryClientProvider>,
  );
}

describe("SegmentButton", () => {
  beforeEach(() => {
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 7, job_type: "sam3_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);
  });

  it("enters point-picking mode on click, then enqueues a predict job on image click", async () => {
    const onJobCreated = vi.fn();
    renderButton(onJobCreated);

    await userEvent.click(screen.getByRole("button", { name: "Segment with SAM-3" }));

    expect(screen.getByText("Select a label for the SAM-3 mask")).toBeInTheDocument();
  });

  it("does not allow picking a point until a label has been selected", async () => {
    const onJobCreated = vi.fn();
    renderButton(onJobCreated);

    await userEvent.click(screen.getByRole("button", { name: "Segment with SAM-3" }));

    expect(screen.queryByText("Click a point on the frame to segment")).not.toBeInTheDocument();
  });

  it("calls POST /jobs/sam3/predict with a point prompt and the selected label_id when the frame image is clicked in picking mode", async () => {
    const onJobCreated = vi.fn();
    renderButton(onJobCreated);

    await userEvent.click(screen.getByRole("button", { name: "Segment with SAM-3" }));
    await userEvent.click(screen.getByRole("button", { name: "Polyp" }));

    expect(screen.getByText("Click a point on the frame to segment")).toBeInTheDocument();

    const image = screen.getByTestId("segment-click-target");
    Object.defineProperty(image, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    });
    fireEvent.click(image, { clientX: 100, clientY: 50 });

    await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith(
      "/jobs/sam3/predict",
      expect.objectContaining({
        body: {
          frame_id: 42,
          label_id: 5,
          prompts: [{ type: "point", coords: [0.5, 0.5], label: true }],
        },
      }),
    ));
    await waitFor(() => expect(onJobCreated).toHaveBeenCalledWith(7));
  });

  it("normalizes click coordinates against the letterboxed image content, not the raw bounding box, when the container aspect ratio differs from the image's natural aspect ratio", async () => {
    const onJobCreated = vi.fn();
    renderButton(onJobCreated);

    await userEvent.click(screen.getByRole("button", { name: "Segment with SAM-3" }));
    await userEvent.click(screen.getByRole("button", { name: "Polyp" }));

    const image = screen.getByTestId("segment-click-target") as HTMLImageElement;

    // Simulate a real 400x200 (2:1) image rendered with object-contain inside
    // a 200x200 (1:1) box. Since the aspect ratios differ, object-contain
    // letterboxes: the image is scaled by min(200/400, 200/200) = 0.5,
    // producing a 200x100 rendered picture centered vertically inside the
    // 200x200 box (50px of empty space above and below).
    Object.defineProperty(image, "naturalWidth", { value: 400, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: 200, configurable: true });
    Object.defineProperty(image, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 200, height: 200 }),
      configurable: true,
    });

    // Click at (100, 75): x=100 sits at the horizontal midpoint of both the
    // box and the rendered content (no horizontal letterboxing here), but
    // y=75 is 25px into the 100px-tall rendered content past the 50px top
    // offset -- i.e. 25% down the actual image, NOT 37.5% down the raw box.
    fireEvent.click(image, { clientX: 100, clientY: 75 });

    await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith(
      "/jobs/sam3/predict",
      expect.objectContaining({
        body: {
          frame_id: 42,
          label_id: 5,
          prompts: [{ type: "point", coords: [0.5, 0.25], label: true }],
        },
      }),
    ));
  });
});

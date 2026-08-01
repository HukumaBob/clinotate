import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceFromMarksForm } from "./SequenceFromMarksForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SequenceFromMarksForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("submits with start_time and duration derived from the marks, not typed fields", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-29 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 42, name: "EGD 2026-07-29 #1", video_id: 5, procedure_id: 1, start_time: 10, duration: 20 },
      error: undefined,
    } as never);

    const onCreated = vi.fn();
    render(
      <SequenceFromMarksForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onCreated={onCreated}
      />,
      { wrapper }
    );

    await userEvent.click(await screen.findByRole("button", { name: /create sequence/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(apiClient.POST).toHaveBeenCalledWith(
      "/media/videos/{video_id}/sequences",
      expect.objectContaining({
        body: expect.objectContaining({ start_time: 10, duration: 20 }),
      })
    );
  });

  it("inherits crop from the most-recently-created existing sequence", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);

    render(
      <SequenceFromMarksForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[
          { id: 1, name: "First", video_id: 5, procedure_id: 1, start_time: 0, duration: 10, annotation_count: 0, crop_box: { left: 5, right: 5, top: 0, bottom: 0 } },
          { id: 2, name: "Second", video_id: 5, procedure_id: 1, start_time: 10, duration: 10, annotation_count: 0, crop_box: { left: 20, right: 15, top: 10, bottom: 8 } },
        ]}
        onCreated={vi.fn()}
      />,
      { wrapper }
    );

    expect(await screen.findByLabelText(/left %/i)).toHaveValue(20);
    expect(screen.getByLabelText(/right %/i)).toHaveValue(15);
    expect(screen.getByLabelText(/top %/i)).toHaveValue(10);
    expect(screen.getByLabelText(/bottom %/i)).toHaveValue(8);
  });

  it("defaults crop to zero when the video has no existing sequences", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);

    render(
      <SequenceFromMarksForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onCreated={vi.fn()}
      />,
      { wrapper }
    );

    expect(await screen.findByLabelText(/left %/i)).toHaveValue(0);
  });

  it("reports the inherited crop to the parent via onCropChange", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    const onCropChange = vi.fn();

    render(
      <SequenceFromMarksForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={onCropChange}
        existingSequences={[
          { id: 1, name: "First", video_id: 5, procedure_id: 1, start_time: 0, duration: 10, annotation_count: 0, crop_box: { left: 5, right: 5, top: 0, bottom: 0 } },
        ]}
        onCreated={vi.fn()}
      />,
      { wrapper }
    );

    await waitFor(() =>
      expect(onCropChange).toHaveBeenCalledWith({ left: 5, right: 5, top: 0, bottom: 0 })
    );
  });

  it("shows an error message when creating the sequence fails", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-29 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: undefined,
      error: { detail: "start_time + duration exceeds the video's duration" },
    } as never);

    render(
      <SequenceFromMarksForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onCreated={vi.fn()}
      />,
      { wrapper }
    );

    await userEvent.click(await screen.findByRole("button", { name: /create sequence/i }));

    expect(await screen.findByText(/failed to create sequence/i)).toBeInTheDocument();
  });

  it("disables the submit button while the create request is pending, so a slow request can't be double-submitted", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-29 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    let resolvePost!: (value: unknown) => void;
    vi.mocked(apiClient.POST).mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      }) as never
    );

    render(
      <SequenceFromMarksForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onCreated={vi.fn()}
      />,
      { wrapper }
    );

    const button = await screen.findByRole("button", { name: /create sequence/i });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(apiClient.POST).toHaveBeenCalledTimes(1);

    // A second click while pending must not fire a second request.
    await userEvent.click(button);
    expect(apiClient.POST).toHaveBeenCalledTimes(1);

    resolvePost({
      data: { id: 42, name: "EGD 2026-07-29 #1", video_id: 5, procedure_id: 1, start_time: 10, duration: 20 },
      error: undefined,
    });
  });
});

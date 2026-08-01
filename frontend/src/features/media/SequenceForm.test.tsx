import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceForm } from "./SequenceForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SequenceForm create mode (no sequence prop)", () => {
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
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onDone={onCreated}
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
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[
          { id: 1, name: "First", video_id: 5, procedure_id: 1, start_time: 0, duration: 10, annotation_count: 0, crop_box: { left: 5, right: 5, top: 0, bottom: 0 } },
          { id: 2, name: "Second", video_id: 5, procedure_id: 1, start_time: 10, duration: 10, annotation_count: 0, crop_box: { left: 20, right: 15, top: 10, bottom: 8 } },
        ]}
        onDone={vi.fn()}
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
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(await screen.findByLabelText(/left %/i)).toHaveValue(0);
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
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onDone={vi.fn()}
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
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const button = await screen.findByRole("button", { name: /create sequence/i });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(apiClient.POST).toHaveBeenCalledTimes(1);

    await userEvent.click(button);
    expect(apiClient.POST).toHaveBeenCalledTimes(1);

    resolvePost({
      data: { id: 42, name: "EGD 2026-07-29 #1", video_id: 5, procedure_id: 1, start_time: 10, duration: 20 },
      error: undefined,
    });
  });
});

describe("SequenceForm edit mode (sequence prop present)", () => {
  afterEach(() => vi.clearAllMocks());

  const sequence = {
    id: 9, name: "To be edited", video_id: 5, procedure_id: 1,
    start_time: 0, duration: 20, annotation_count: 3, crop_box: null,
  };

  it("shows the exact annotation count that will be deleted, only once confirming", async () => {
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.queryByText(/3 annotation/i)).not.toBeInTheDocument();

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/3 annotation/i)).toBeInTheDocument();
  });

  it("saves name/procedure changes directly, with no confirmation step, when range and crop are unchanged", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, name: "Renamed" },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    const nameInput = screen.getByLabelText(/^name$/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: expect.objectContaining({ name: "Renamed" }),
      })
    );
    // No confirm dialog ever appeared.
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("requires confirmation and submits full re-cut payload when the range changed", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, start_time: 0, duration: 15 },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: expect.objectContaining({ start_time: 0, duration: 15, fps: 2 }),
      })
    );
  });

  it("does not submit if the range-change confirmation is cancelled, and returns to the editable state", async () => {
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(apiClient.PATCH).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeInTheDocument();
  });

  it("shows an error and returns to the editable state when the confirmed save fails", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: undefined,
      error: { detail: "start_time + duration exceeds the video's duration" },
    } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("lets the user leave edit mode without saving via a top-level Close button", async () => {
    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

    expect(onDone).toHaveBeenCalled();
    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it("disables the Save button when fps is empty and the range or crop changed", async () => {
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const saveButton = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("does not require fps when only name/procedure changed (range and crop untouched)", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, name: "Renamed" },
      error: undefined,
    } as never);

    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const saveButton = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
  });

  it("pre-fills crop fields from the sequence's existing crop_box", () => {
    render(
      <SequenceForm
        sequence={{ ...sequence, crop_box: { left: 12, right: 8, top: 4, bottom: 6 } }}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByLabelText(/left %/i)).toHaveValue(12);
    expect(screen.getByLabelText(/right %/i)).toHaveValue(8);
    expect(screen.getByLabelText(/top %/i)).toHaveValue(4);
    expect(screen.getByLabelText(/bottom %/i)).toHaveValue(6);
  });

  it("defaults crop fields to zero when the sequence has no crop_box", () => {
    render(
      <SequenceForm
        sequence={{ ...sequence, crop_box: null }}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByLabelText(/left %/i)).toHaveValue(0);
    expect(screen.getByLabelText(/right %/i)).toHaveValue(0);
    expect(screen.getByLabelText(/top %/i)).toHaveValue(0);
    expect(screen.getByLabelText(/bottom %/i)).toHaveValue(0);
  });

  it("requires confirmation when only the crop changed, even if the range did not", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, crop_box: { left: 20, right: 0, top: 0, bottom: 0 } },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    await userEvent.clear(screen.getByLabelText(/fps/i));
    await userEvent.type(screen.getByLabelText(/fps/i), "2");
    await userEvent.clear(screen.getByLabelText(/left %/i));
    await userEvent.type(screen.getByLabelText(/left %/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        body: expect.objectContaining({
          crop: { left: 20, right: 0, top: 0, bottom: 0 },
        }),
      })
    );
  });

  it("reports crop changes to the parent via onCropChange", async () => {
    const onCropChange = vi.fn();
    render(
      <SequenceForm
        sequence={{ ...sequence, crop_box: { left: 12, right: 8, top: 4, bottom: 6 } }}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={onCropChange}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    await waitFor(() =>
      expect(onCropChange).toHaveBeenCalledWith({ left: 12, right: 8, top: 4, bottom: 6 })
    );

    await userEvent.clear(screen.getByLabelText(/left %/i));
    await userEvent.type(screen.getByLabelText(/left %/i), "20");

    await waitFor(() =>
      expect(onCropChange).toHaveBeenLastCalledWith({ left: 20, right: 8, top: 4, bottom: 6 })
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { RecutSequenceForm } from "./RecutSequenceForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const sequence = {
  id: 9, name: "To be re-cut", video_id: 5, procedure_id: 1,
  start_time: 0, duration: 20, annotation_count: 3, crop_box: null,
};

describe("RecutSequenceForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the exact annotation count that will be deleted", async () => {
    render(
      <RecutSequenceForm
        sequence={sequence}
        markStart={0}
        markEnd={15}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByText(/3 annotation/i)).toBeInTheDocument();
  });

  it("does not show a deletion warning when annotation_count is zero", async () => {
    render(
      <RecutSequenceForm
        sequence={{ ...sequence, annotation_count: 0 }}
        markStart={0}
        markEnd={15}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.queryByText(/annotation/i)).not.toBeInTheDocument();
  });

  it("submits start_time/duration from marks and the typed fps via PATCH", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, start_time: 0, duration: 15 },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(
      <RecutSequenceForm
        sequence={sequence}
        markStart={0}
        markEnd={15}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.clear(fpsInput);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /re-cut/i }));
    // Confirmation dialog appears; confirm it.
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

  it("does not submit if the confirmation is dismissed", async () => {
    render(
      <RecutSequenceForm
        sequence={sequence}
        markStart={0}
        markEnd={15}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.clear(fpsInput);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /re-cut/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it("shows an error message and returns to the editable state when the PATCH fails", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: undefined,
      error: { detail: "start_time + duration exceeds the video's duration" },
    } as never);

    const onDone = vi.fn();
    render(
      <RecutSequenceForm
        sequence={sequence}
        markStart={0}
        markEnd={15}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.clear(fpsInput);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /re-cut/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    expect(await screen.findByText(/re-cut failed/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    // Returned to the editable state: the Re-cut button is showing again, not Confirm/Cancel.
    expect(await screen.findByRole("button", { name: /re-cut/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("disables the Re-cut button when fps is empty", async () => {
    render(
      <RecutSequenceForm
        sequence={sequence}
        markStart={0}
        markEnd={15}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const recutButton = screen.getByRole("button", { name: /re-cut/i }) as HTMLButtonElement;
    expect(recutButton.disabled).toBe(true);
  });

  it("pre-fills crop fields from the sequence's existing crop_box", () => {
    render(
      <RecutSequenceForm
        sequence={{ ...sequence, crop_box: { left: 12, right: 8, top: 4, bottom: 6 } }}
        markStart={0}
        markEnd={15}
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
      <RecutSequenceForm
        sequence={{ ...sequence, crop_box: null }}
        markStart={0}
        markEnd={15}
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

  it("submits the edited crop values via PATCH", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, start_time: 0, duration: 15, crop_box: { left: 20, right: 0, top: 0, bottom: 0 } },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(
      <RecutSequenceForm
        sequence={sequence}
        markStart={0}
        markEnd={15}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    await userEvent.clear(screen.getByLabelText(/fps/i));
    await userEvent.type(screen.getByLabelText(/fps/i), "2");
    await userEvent.clear(screen.getByLabelText(/left %/i));
    await userEvent.type(screen.getByLabelText(/left %/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /re-cut/i }));
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
      <RecutSequenceForm
        sequence={{ ...sequence, crop_box: { left: 12, right: 8, top: 4, bottom: 6 } }}
        markStart={0}
        markEnd={15}
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

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
  start_time: 0, duration: 20, annotation_count: 3,
};

describe("RecutSequenceForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the exact annotation count that will be deleted", async () => {
    render(
      <RecutSequenceForm sequence={sequence} markStart={0} markEnd={15} onDone={vi.fn()} />,
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
      <RecutSequenceForm sequence={sequence} markStart={0} markEnd={15} onDone={onDone} />,
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
      <RecutSequenceForm sequence={sequence} markStart={0} markEnd={15} onDone={vi.fn()} />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.clear(fpsInput);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /re-cut/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it("disables the Re-cut button when fps is empty", async () => {
    render(
      <RecutSequenceForm sequence={sequence} markStart={0} markEnd={15} onDone={vi.fn()} />,
      { wrapper }
    );

    const recutButton = screen.getByRole("button", { name: /re-cut/i }) as HTMLButtonElement;
    expect(recutButton.disabled).toBe(true);
  });
});

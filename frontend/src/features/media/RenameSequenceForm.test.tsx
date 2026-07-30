import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { RenameSequenceForm } from "./RenameSequenceForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const sequence = {
  id: 7, name: "Original name", video_id: 5, procedure_id: 1,
  start_time: 0, duration: 20, annotation_count: 0,
};

describe("RenameSequenceForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("submits the edited name and procedure via PATCH", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }, { id: 2, name: "Colono" }], error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, name: "New name", procedure_id: 2 },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(<RenameSequenceForm sequence={sequence} onDone={onDone} />, { wrapper });

    const nameInput = await screen.findByLabelText(/name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "New name");
    await userEvent.selectOptions(screen.getByLabelText(/procedure/i), "2");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        params: { path: { sequence_id: 7 } },
        body: expect.objectContaining({ name: "New name", procedure_id: 2 }),
      })
    );
  });

  it("calls onDone without saving when Cancel is clicked", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    const onDone = vi.fn();
    render(<RenameSequenceForm sequence={sequence} onDone={onDone} />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(onDone).toHaveBeenCalled();
    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });
});

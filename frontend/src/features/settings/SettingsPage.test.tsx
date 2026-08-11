import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SettingsPage } from "./SettingsPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SettingsPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("pre-fills the field with the current value from GET /settings", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);

    render(<SettingsPage />, { wrapper });

    await waitFor(() =>
      expect(screen.getByLabelText(/max sam2 tracking range/i)).toHaveValue(10)
    );
  });

  it("submits the edited value via PATCH /settings", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { max_track_range_frames: 8 },
      error: undefined,
    } as never);

    render(<SettingsPage />, { wrapper });

    const input = await screen.findByLabelText(/max sam2 tracking range/i);
    await userEvent.clear(input);
    await userEvent.type(input, "8");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith("/settings", {
        body: { max_track_range_frames: 8 },
      })
    );
  });

  it("shows an inline error message when the save fails", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { max_track_range_frames: 10 },
      error: undefined,
    } as never);
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: undefined,
      error: { detail: "Admin role required" },
    } as never);

    render(<SettingsPage />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: /save/i }));

    await waitFor(() => expect(screen.getByText("Admin role required")).toBeInTheDocument());
  });
});

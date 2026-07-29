import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { PhotosUploadFlow } from "./PhotosUploadFlow";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("PhotosUploadFlow", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the backend's error message inline when the batch upload fails", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [{ id: 1, name: "EGD" }],
      error: undefined,
    } as never);
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: undefined,
      error: { detail: "File 'bad.png' is not a valid image" },
    } as never);

    render(<PhotosUploadFlow onCreated={vi.fn()} />, { wrapper });

    const file = new File(["x"], "bad.png", { type: "image/png" });
    const input = screen.getByLabelText(/choose photos/i);
    await userEvent.upload(input, file);

    const procedureSelect = await screen.findByLabelText(/procedure/i);
    await userEvent.selectOptions(procedureSelect, "1");
    await userEvent.click(screen.getByRole("button", { name: /create sequence/i }));

    await waitFor(() =>
      expect(screen.getByText(/not a valid image/i)).toBeInTheDocument()
    );
  });
});

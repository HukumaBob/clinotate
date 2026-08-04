import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { VideoUploadFlow } from "./VideoUploadFlow";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("VideoUploadFlow", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls onVideoUploaded with the new video's id after a successful upload, without rendering a form of its own", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [{ id: 1, name: "EGD" }],
      error: undefined,
    } as never);
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 42, filename: "a.mp4", title: "A", procedure_id: 1 },
      error: undefined,
    } as never);

    const onVideoUploaded = vi.fn();
    render(<VideoUploadFlow onVideoUploaded={onVideoUploaded} />, { wrapper });

    const file = new File(["data"], "a.mp4", { type: "video/mp4" });
    await userEvent.type(screen.getByLabelText(/title/i), "A");
    await userEvent.selectOptions(await screen.findByLabelText(/procedure/i), "1");
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(fileInput, file);
    fireEvent.submit(fileInput.closest("form") as HTMLFormElement);

    await waitFor(() => expect(onVideoUploaded).toHaveBeenCalledWith(42));
  });

  it("requires a procedure to be selected before the form can submit", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [{ id: 1, name: "EGD" }],
      error: undefined,
    } as never);

    render(<VideoUploadFlow onVideoUploaded={vi.fn()} />, { wrapper });

    const select = (await screen.findByLabelText(/procedure/i)) as HTMLSelectElement;
    expect(select).toBeRequired();
    expect(select.value).toBe("");
  });
});

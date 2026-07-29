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
      <SequenceFromMarksForm videoId={5} markStart={10} markEnd={30} procedureId={1} onCreated={onCreated} />,
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
});

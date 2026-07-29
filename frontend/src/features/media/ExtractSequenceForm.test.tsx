import { describe, expect, it, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { ExtractSequenceForm } from "./ExtractSequenceForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("ExtractSequenceForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("pre-fills the name field from the suggest-name endpoint once a procedure is selected", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-28 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(<ExtractSequenceForm videoId={1} onCreated={vi.fn()} />, { wrapper });

    await waitFor(() =>
      expect(screen.getByLabelText(/name/i)).toHaveValue("EGD 2026-07-28 #1")
    );
  });
});

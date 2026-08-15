import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { DatasetsPage } from "./DatasetsPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const SEQUENCES = {
  items: [
    { id: 1, name: "seq-a", video_id: 1, procedure_id: 1, frame_count: 100, labeled_frame_count: 10, preview_frames: [] },
    { id: 2, name: "seq-b", video_id: 1, procedure_id: 1, frame_count: 50, labeled_frame_count: 0, preview_frames: [] },
  ],
  total: 2,
};

const BALANCE = {
  classes: [{ label_id: 1, name: "polyp", instances: 35, frames: 33 }],
  total_frames: 33,
  negative_frames: 0,
  below_threshold: [],
  threshold: 10,
  metrics: { severity: "moderate_imbalance" },
};

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("DatasetsPage", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences") return { data: SEQUENCES };
      if (path === "/datasets") return { data: [] };
      if (path === "/taxonomy/procedures") return { data: [] };
      return { data: [] };
    });
    vi.mocked(apiClient.POST).mockResolvedValue({ data: BALANCE });
  });

  it("lists selectable sequences", async () => {
    render(<DatasetsPage />, { wrapper });
    expect(await screen.findByText("seq-a")).toBeInTheDocument();
    expect(screen.getByText("seq-b")).toBeInTheDocument();
  });

  it("requests a balance recompute when a sequence is selected", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));

    await waitFor(() => {
      const balanceCalls = vi
        .mocked(apiClient.POST)
        .mock.calls.filter(([path]) => path === "/datasets/balance");
      expect(balanceCalls.length).toBeGreaterThan(0);
      expect(balanceCalls.at(-1)?.[1]?.body?.sequence_ids).toContain(1);
    });
  });

  it("disables saving until the dataset has a name", async () => {
    render(<DatasetsPage />, { wrapper });
    expect(await screen.findByRole("button", { name: /save dataset/i })).toBeDisabled();

    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeEnabled();
  });

  it("shows Test percentage as the computed remainder", async () => {
    render(<DatasetsPage />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("test-remainder")).toHaveTextContent("10"));
  });

  it("disables saving with zero sequences selected, and enables once one is picked", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeDisabled();

    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeEnabled();
  });

  it("disables saving and shows a message when train + val exceeds 100", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeEnabled();

    const trainInput = screen.getByLabelText(/train %/i);
    await userEvent.clear(trainInput);
    await userEvent.type(trainInput, "70");
    const valInput = screen.getByLabelText(/val %/i);
    await userEvent.clear(valInput);
    await userEvent.type(valInput, "50");

    expect(screen.getByRole("button", { name: /save dataset/i })).toBeDisabled();
    expect(screen.getByText(/train.*val.*(must not exceed|<=|exceed).*100/i)).toBeInTheDocument();
  });

  it("disables saving while a create mutation is pending", async () => {
    let resolveCreate: (() => void) | undefined;
    vi.mocked(apiClient.POST).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return new Promise((resolve) => {
          resolveCreate = () => resolve({ data: { id: 1 } });
        });
      }
      return { data: BALANCE };
    });

    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");

    const saveButton = screen.getByRole("button", { name: /save dataset/i });
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());

    resolveCreate?.();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactGallery } from "./ArtifactGallery";
import { apiClient } from "../../shared/api/client";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

const artifacts = [
  { name: "confusion_matrix.png", index: 0 },
  { name: "BoxPR_curve.png", index: 1 },
  { name: "results.csv", index: 2 },
];

describe("ArtifactGallery", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset();
    vi.mocked(apiClient.GET).mockImplementation(async (_path: string, options: any) => ({
      data: { download_url: `https://example.invalid/${options.params.path.index}.png` },
    }));
  });

  it("renders a card per artifact, with images loaded as previews", async () => {
    render(<ArtifactGallery versionId={1} artifacts={artifacts} />);

    expect(document.querySelectorAll("[data-artifact-card]")).toHaveLength(3);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    // The non-image artifact gets a card too -- results.csv is often the
    // most useful file -- but no <img>.
    expect(screen.getByText("results.csv")).toBeInTheDocument();
  });

  it("opens a lightbox when an image card is clicked", async () => {
    render(<ArtifactGallery versionId={1} artifacts={artifacts} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));

    await userEvent.click(screen.getByRole("button", { name: /confusion_matrix\.png/ }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "confusion_matrix.png");
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("steps between images and closes on Escape", async () => {
    render(<ArtifactGallery versionId={1} artifacts={artifacts} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));

    await userEvent.click(screen.getByRole("button", { name: /confusion_matrix\.png/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next artifact" }));

    expect(await screen.findByText("2 / 2")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does not open a lightbox for a non-image artifact", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);

    render(<ArtifactGallery versionId={1} artifacts={artifacts} />);
    await userEvent.click(screen.getByRole("button", { name: /results\.csv/ }));

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it("renders nothing when there are no artifacts", () => {
    const { container } = render(<ArtifactGallery versionId={1} artifacts={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

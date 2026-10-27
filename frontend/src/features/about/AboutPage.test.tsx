import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { AboutPage } from "./AboutPage";

describe("AboutPage", () => {
  it("shows the platform title, a table of contents and the workflow diagram", () => {
    render(<AboutPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Endoscopy Annotation Platform" }),
    ).toBeInTheDocument();
    const toc = screen.getByRole("navigation", { name: "On this page" });
    for (const title of ["Overview", "Workflow", "Tags", "Media", "Sequences", "Dataset", "Train", "QC", "Architecture", "Glossary", "License"]) {
      expect(within(toc).getByRole("button", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByRole("img", { name: /workflow/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /architecture/i })).toBeInTheDocument();
  });

  it("filters sections and the table of contents by the search query", () => {
    render(<AboutPage />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search this page" }), {
      target: { value: "pgvector" },
    });
    const toc = screen.getByRole("navigation", { name: "On this page" });
    expect(within(toc).queryByRole("button", { name: "License" })).not.toBeInTheDocument();
    expect(within(toc).getByRole("button", { name: "Architecture" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "License" })).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing matches and recovers when cleared", () => {
    render(<AboutPage />);
    const box = screen.getByRole("searchbox", { name: "Search this page" });
    fireEvent.change(box, { target: { value: "zzzzqqqq" } });
    expect(screen.getByText(/No results for/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "License" })).toBeInTheDocument();
  });

  it("focuses the search box on the / shortcut", () => {
    render(<AboutPage />);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByRole("searchbox", { name: "Search this page" })).toHaveFocus();
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MediaLibraryPagination } from "./MediaLibraryPagination";

describe("MediaLibraryPagination", () => {
  it("renders nothing when everything fits on one page", () => {
    const { container } = render(
      <MediaLibraryPagination total={10} page={1} pageSize={25} onPageChange={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a button per page and highlights the current page", () => {
    render(<MediaLibraryPagination total={55} page={2} pageSize={25} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();
    const current = screen.getByRole("button", { name: "2" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "3" })).toBeInTheDocument();
  });

  it("calls onPageChange with the clicked page number", async () => {
    const onPageChange = vi.fn();
    render(<MediaLibraryPagination total={55} page={1} pageSize={25} onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole("button", { name: "3" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("disables Previous on the first page and Next on the last page", () => {
    const { rerender } = render(
      <MediaLibraryPagination total={55} page={1} pageSize={25} onPageChange={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();

    rerender(<MediaLibraryPagination total={55} page={3} pageSize={25} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /previous/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("calls onPageChange with page - 1 / page + 1 for Previous/Next", async () => {
    const onPageChange = vi.fn();
    render(<MediaLibraryPagination total={55} page={2} pageSize={25} onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});

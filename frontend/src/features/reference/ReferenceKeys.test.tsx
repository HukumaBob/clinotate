import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReferenceKeys } from "./ReferenceKeys";
import type { RefAxis } from "./types";

const AXES: RefAxis[] = [
  {
    categoryId: 2,
    name: "Location",
    classes: [
      { labelId: 10, name: "Antrum", key: "1" },
      { labelId: 11, name: "Body", key: null },
    ],
  },
  { categoryId: 3, name: "Quality", classes: [{ labelId: 20, name: "Good", key: "3" }] },
];

describe("ReferenceKeys", () => {
  it("groups chips by axis, each showing its key and name", () => {
    render(<ReferenceKeys axes={AXES} onPress={vi.fn()} />);
    expect(screen.getByText("Location")).toBeInTheDocument();
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1\s*Antrum/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /3\s*Good/ })).toBeInTheDocument();
  });

  it("marks a keyless chip", () => {
    render(<ReferenceKeys axes={AXES} onPress={vi.fn()} />);
    const chip = screen.getByRole("button", { name: /Body/ });
    expect(chip).toHaveAttribute("title", "No key: click to use");
    expect(chip).toHaveTextContent("–");
  });

  it("a click on a chip calls onPress with its axis and class", () => {
    const onPress = vi.fn();
    render(<ReferenceKeys axes={AXES} onPress={onPress} />);
    fireEvent.click(screen.getByRole("button", { name: /Body/ }));
    expect(onPress).toHaveBeenCalledWith(2, 11);
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SplitWarnings } from "./SplitWarnings";

const report = (messages: string[]) =>
  ({
    classes: [],
    train: { frames: 0, units: 0, share: 0, target: 0.7 },
    val: { frames: 0, units: 0, share: 0, target: 0.2 },
    test: { frames: 0, units: 0, share: 0, target: 0.1 },
    warnings: messages.map((message) => ({ kind: "few_units" as const, message, label_id: 1, split: null })),
  });

describe("SplitWarnings", () => {
  it("renders nothing without a report, or without warnings", () => {
    const { container, rerender } = render(<SplitWarnings report={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SplitWarnings report={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SplitWarnings report={report([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the warnings and lists each message", () => {
    render(<SplitWarnings report={report(["colon_left has no test.", "colon_right has no val."])} />);
    expect(screen.getByText("2 split warnings")).toBeInTheDocument();
    expect(screen.getByText("colon_left has no test.")).toBeInTheDocument();
    expect(screen.getByText("colon_right has no val.")).toBeInTheDocument();
  });

  it("uses the singular for one warning", () => {
    render(<SplitWarnings report={report(["only one."])} />);
    expect(screen.getByText("1 split warning")).toBeInTheDocument();
  });
});

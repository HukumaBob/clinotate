import { describe, expect, it } from "vitest";

import { decideFlagAction } from "./flagDecision";

describe("decideFlagAction", () => {
  it("creates a flag on an unflagged frame", () => {
    expect(decideFlagAction(undefined, "fp")).toBe("create");
    expect(decideFlagAction(undefined, "fn")).toBe("create");
  });

  it("removes the flag when the same kind is pressed again", () => {
    expect(decideFlagAction({ kind: "fp", committed: false }, "fp")).toBe("remove");
    expect(decideFlagAction({ kind: "fn", committed: false }, "fn")).toBe("remove");
  });

  it("changes the flag when the other kind is pressed", () => {
    expect(decideFlagAction({ kind: "fp", committed: false }, "fn")).toBe("change");
    expect(decideFlagAction({ kind: "fn", committed: false }, "fp")).toBe("change");
  });

  it("blocks any change to a flag already sent to training", () => {
    expect(decideFlagAction({ kind: "fp", committed: true }, "fp")).toBe("blocked");
    expect(decideFlagAction({ kind: "fp", committed: true }, "fn")).toBe("blocked");
  });
});

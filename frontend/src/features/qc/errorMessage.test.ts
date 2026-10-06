import { describe, expect, it } from "vitest";

import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("returns a string detail as is", () => {
    expect(errorMessage({ detail: "Video 3 not found" }, "fallback")).toBe("Video 3 not found");
  });

  it("joins the msgs of a FastAPI 422 detail array", () => {
    const error = { detail: [{ msg: "Input should be >= 1" }, { msg: "Field required" }] };
    expect(errorMessage(error, "fallback")).toBe("Input should be >= 1; Field required");
  });

  it("falls back for any other shape", () => {
    expect(errorMessage({ detail: 42 }, "fallback")).toBe("fallback");
    expect(errorMessage({ detail: [{ nope: 1 }] }, "fallback")).toBe("fallback");
    expect(errorMessage(new Error("x"), "fallback")).toBe("fallback");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });
});

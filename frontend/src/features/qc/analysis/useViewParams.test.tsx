import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PARAMS_STORAGE_KEY } from "./params";
import { useViewParams } from "./useViewParams";
import { DEFAULT_VIEW_PARAMS } from "./view";

describe("useViewParams", () => {
  beforeEach(() => window.localStorage.removeItem(PARAMS_STORAGE_KEY));
  afterEach(() => window.localStorage.removeItem(PARAMS_STORAGE_KEY));

  it("starts from the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useViewParams());
    expect(result.current[0]).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("starts from stored values", () => {
    window.localStorage.setItem(
      PARAMS_STORAGE_KEY,
      JSON.stringify({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 }),
    );
    const { result } = renderHook(() => useViewParams());
    expect(result.current[0]).toEqual({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 });
  });

  it("clamps what is set and persists it", () => {
    const { result } = renderHook(() => useViewParams());
    act(() => result.current[1]({ threshold: 5, nmsIou: 0.4, flickerN: 3 }));
    expect(result.current[0]).toEqual({ threshold: 1, nmsIou: 0.4, flickerN: 3 });
    expect(JSON.parse(window.localStorage.getItem(PARAMS_STORAGE_KEY)!)).toEqual({
      threshold: 1,
      nmsIou: 0.4,
      flickerN: 3,
    });
  });

  it("reset returns to the defaults and persists them", () => {
    const { result } = renderHook(() => useViewParams());
    act(() => result.current[1]({ threshold: 0.6, nmsIou: 0.4, flickerN: 5 }));
    act(() => result.current[2]());
    expect(result.current[0]).toEqual(DEFAULT_VIEW_PARAMS);
    expect(JSON.parse(window.localStorage.getItem(PARAMS_STORAGE_KEY)!)).toEqual(DEFAULT_VIEW_PARAMS);
  });
});

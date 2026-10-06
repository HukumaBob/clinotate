import { afterEach, describe, expect, it } from "vitest";

import { PARAMS_STORAGE_KEY, clampParams, loadParams, saveParams } from "./params";
import { DEFAULT_VIEW_PARAMS } from "./view";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("clampParams", () => {
  it("returns the defaults for an empty object", () => {
    expect(clampParams({})).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("clamps out-of-range numbers to the limits", () => {
    expect(clampParams({ threshold: 5, nmsIou: 0.01, flickerN: 99 })).toEqual({
      threshold: 1,
      nmsIou: 0.3,
      flickerN: 10,
    });
    expect(clampParams({ threshold: -1, nmsIou: 9, flickerN: 0 })).toEqual({
      threshold: 0.05,
      nmsIou: 0.7,
      flickerN: 1,
    });
  });

  it("falls back to the default for non-numeric values", () => {
    expect(clampParams({ threshold: "abc", nmsIou: null, flickerN: NaN })).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("treats Infinity and -Infinity as non-numeric and falls back to the default (non-finite)", () => {
    expect(clampParams({ threshold: Infinity, nmsIou: -Infinity, flickerN: Infinity })).toEqual(
      DEFAULT_VIEW_PARAMS,
    );
  });

  it("rounds thresholds to two decimals and the flicker window to whole frames", () => {
    expect(clampParams({ threshold: 0.333333, nmsIou: 0.4166, flickerN: 2.6 })).toEqual({
      threshold: 0.33,
      nmsIou: 0.42,
      flickerN: 3,
    });
  });
});

describe("loadParams / saveParams", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    saveParams({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 }, storage);
    expect(storage.data[PARAMS_STORAGE_KEY]).toBeDefined();
    expect(loadParams(storage)).toEqual({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 });
  });

  it("returns the defaults when nothing is stored", () => {
    expect(loadParams(memoryStorage())).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("returns the defaults for corrupt JSON", () => {
    expect(loadParams(memoryStorage({ [PARAMS_STORAGE_KEY]: "{not json" }))).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("clamps stored values that are out of range", () => {
    const stored = JSON.stringify({ threshold: 7, nmsIou: 0.5, flickerN: 2 });
    expect(loadParams(memoryStorage({ [PARAMS_STORAGE_KEY]: stored })).threshold).toBe(1);
  });

  it("returns the defaults when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadParams(throwing)).toEqual(DEFAULT_VIEW_PARAMS);
    expect(() => saveParams(DEFAULT_VIEW_PARAMS, throwing)).not.toThrow();
  });
});

describe("blocked window.localStorage", () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(window, "localStorage", original);
  });

  it("loadParams() and saveParams() with no argument do not throw when reading localStorage throws", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(loadParams()).toEqual(DEFAULT_VIEW_PARAMS);
    expect(() => saveParams(DEFAULT_VIEW_PARAMS)).not.toThrow();
  });
});

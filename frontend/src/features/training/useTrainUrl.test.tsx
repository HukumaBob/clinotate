import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { useTrainUrl } from "./useTrainUrl";

const wrapper = (initial: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  };

describe("useTrainUrl", () => {
  it("defaults to the runs tab with nothing selected", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train") });

    expect(result.current[0]).toEqual({ dataset: null, tab: "runs", run: null, view: "overview", compare: [], compareOpen: false });
  });

  it("reads dataset, tab, run and view from the query string", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=496&tab=new&run=268&view=log"),
    });

    expect(result.current[0]).toEqual({ dataset: 496, tab: "new", run: 268, view: "log", compare: [], compareOpen: false });
  });

  it("ignores nonsense values", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=abc&tab=zzz&run=-3&view=x"),
    });

    expect(result.current[0]).toEqual({ dataset: null, tab: "runs", run: null, view: "overview", compare: [], compareOpen: false });
  });

  it("merges a patch and omits defaults from the URL", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train?dataset=496") });

    act(() => result.current[1]({ run: 268, view: "metrics" }));
    expect(result.current[0]).toEqual({ dataset: 496, tab: "runs", run: 268, view: "metrics", compare: [], compareOpen: false });

    act(() => result.current[1]({ run: null }));
    expect(result.current[0].run).toBeNull();
    expect(result.current[0].dataset).toBe(496);
  });

  it("switching dataset clears the selected run", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=496&run=268"),
    });

    act(() => result.current[1]({ dataset: 497 }));

    expect(result.current[0]).toEqual({ dataset: 497, tab: "runs", run: null, view: "overview", compare: [], compareOpen: false });
  });

  it("reads compare ids and the open flag", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train?compare=268,406&cmp=1") });
    expect(result.current[0].compare).toEqual([268, 406]);
    expect(result.current[0].compareOpen).toBe(true);
  });

  it("drops duplicates, zero, negatives, non-numbers and ids past the limit", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train?compare=1,2,2,x,0,-4,3,4&cmp=2") });
    expect(result.current[0].compare).toEqual([1, 2, 3]);
    expect(result.current[0].compareOpen).toBe(false);
  });

  it("writes and removes compare and compareOpen", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train?dataset=5") });
    act(() => result.current[1]({ compare: [1, 2], compareOpen: true }));
    expect(result.current[0].compare).toEqual([1, 2]);
    expect(result.current[0].compareOpen).toBe(true);
    act(() => result.current[1]({ compare: [], compareOpen: false }));
    expect(result.current[0].compare).toEqual([]);
    expect(result.current[0].compareOpen).toBe(false);
  });

  it("switching dataset clears compare, compareOpen and run", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=496&compare=1,2&cmp=1"),
    });
    act(() => result.current[1]({ dataset: 497 }));
    expect(result.current[0]).toMatchObject({ dataset: 497, compare: [], compareOpen: false, run: null });
  });

  it("opening a run closes the compare view", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train?compare=1,2&cmp=1") });
    act(() => result.current[1]({ run: 9 }));
    expect(result.current[0]).toMatchObject({ run: 9, compareOpen: false, compare: [1, 2] });
  });
});

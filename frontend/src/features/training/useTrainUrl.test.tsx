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

    expect(result.current[0]).toEqual({ dataset: null, tab: "runs", run: null, view: "overview" });
  });

  it("reads dataset, tab, run and view from the query string", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=496&tab=new&run=268&view=log"),
    });

    expect(result.current[0]).toEqual({ dataset: 496, tab: "new", run: 268, view: "log" });
  });

  it("ignores nonsense values", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=abc&tab=zzz&run=-3&view=x"),
    });

    expect(result.current[0]).toEqual({ dataset: null, tab: "runs", run: null, view: "overview" });
  });

  it("merges a patch and omits defaults from the URL", () => {
    const { result } = renderHook(() => useTrainUrl(), { wrapper: wrapper("/train?dataset=496") });

    act(() => result.current[1]({ run: 268, view: "metrics" }));
    expect(result.current[0]).toEqual({ dataset: 496, tab: "runs", run: 268, view: "metrics" });

    act(() => result.current[1]({ run: null }));
    expect(result.current[0].run).toBeNull();
    expect(result.current[0].dataset).toBe(496);
  });

  it("switching dataset clears the selected run", () => {
    const { result } = renderHook(() => useTrainUrl(), {
      wrapper: wrapper("/train?dataset=496&run=268"),
    });

    act(() => result.current[1]({ dataset: 497 }));

    expect(result.current[0]).toEqual({ dataset: 497, tab: "runs", run: null, view: "overview" });
  });
});

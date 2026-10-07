import { describe, expect, it } from "vitest";

import { eventDirectionFor, flagKindFor, isTypingTarget } from "./eventKeys";

const press = (key: string, code: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("eventDirectionFor", () => {
  it("maps [ and ] on a US layout", () => {
    expect(eventDirectionFor(press("[", "BracketLeft"))).toBe("prev");
    expect(eventDirectionFor(press("]", "BracketRight"))).toBe("next");
  });

  it("matches the physical keys on a Russian layout", () => {
    expect(eventDirectionFor(press("х", "BracketLeft"))).toBe("prev");
    expect(eventDirectionFor(press("ъ", "BracketRight"))).toBe("next");
  });

  it("matches by key when the code is unknown", () => {
    expect(eventDirectionFor(press("[", ""))).toBe("prev");
    expect(eventDirectionFor(press("]", ""))).toBe("next");
  });

  it("ignores Ctrl, Meta and Alt combinations", () => {
    expect(eventDirectionFor(press("[", "BracketLeft", { ctrlKey: true }))).toBeNull();
    expect(eventDirectionFor(press("]", "BracketRight", { metaKey: true }))).toBeNull();
    expect(eventDirectionFor(press("[", "BracketLeft", { altKey: true }))).toBeNull();
  });

  it("does not block Shift", () => {
    expect(eventDirectionFor({ ...press("{", "BracketLeft"), shiftKey: true } as never)).toBe("prev");
  });

  it("ignores unrelated keys", () => {
    expect(eventDirectionFor(press("a", "KeyA"))).toBeNull();
    expect(eventDirectionFor(press("Enter", "Enter"))).toBeNull();
  });
});

describe("isTypingTarget", () => {
  const input = (type: string) => {
    const el = document.createElement("input");
    el.type = type;
    return el;
  };

  it("is true for text-like inputs, textarea and select", () => {
    expect(isTypingTarget(input("text"))).toBe(true);
    expect(isTypingTarget(input("number"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
  });

  it("is true for contentEditable elements", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "isContentEditable", { value: true });
    expect(isTypingTarget(el)).toBe(true);
  });

  it("is false for non-typing inputs", () => {
    for (const type of ["range", "checkbox", "radio", "button", "submit", "reset", "file", "image"]) {
      expect(isTypingTarget(input(type))).toBe(false);
    }
  });

  it("is false for other elements and null", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("flagKindFor", () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, ...init }) as KeyboardEvent;

  it("maps F to a false positive and N to a missed object", () => {
    expect(flagKindFor(key({ key: "f", code: "KeyF" }))).toBe("fp");
    expect(flagKindFor(key({ key: "n", code: "KeyN" }))).toBe("fn");
  });

  it("accepts capital letters (Shift or Caps Lock)", () => {
    expect(flagKindFor(key({ key: "F", code: "KeyF" }))).toBe("fp");
    expect(flagKindFor(key({ key: "N", code: "KeyN" }))).toBe("fn");
  });

  it("works on a Russian layout, where the same physical keys give other letters", () => {
    expect(flagKindFor(key({ key: "а", code: "KeyF" }))).toBe("fp");
    expect(flagKindFor(key({ key: "т", code: "KeyN" }))).toBe("fn");
  });

  it("ignores the keys with Ctrl, Meta or Alt held", () => {
    expect(flagKindFor(key({ key: "f", code: "KeyF", ctrlKey: true }))).toBeNull();
    expect(flagKindFor(key({ key: "n", code: "KeyN", metaKey: true }))).toBeNull();
    expect(flagKindFor(key({ key: "f", code: "KeyF", altKey: true }))).toBeNull();
  });

  it("ignores every other key", () => {
    expect(flagKindFor(key({ key: "g", code: "KeyG" }))).toBeNull();
    expect(flagKindFor(key({ key: "[", code: "BracketLeft" }))).toBeNull();
  });
});

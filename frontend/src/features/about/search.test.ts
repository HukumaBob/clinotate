import { describe, expect, it } from "vitest";

import { filterSections, highlightParts, parseQuery, type Section } from "./search";

const SECTIONS: Section[] = [
  {
    id: "media",
    title: "Media",
    blocks: [
      { type: "p", text: "Upload videos and transcode them." },
      { type: "list", items: ["Procedures", "Review player"] },
    ],
  },
  {
    id: "terms",
    title: "Glossary",
    blocks: [{ type: "terms", items: [{ term: "Job", def: "An asynchronous task." }] }],
  },
  {
    id: "arch",
    title: "Architecture",
    blocks: [{ type: "diagram", id: "architecture", caption: "PostgreSQL, Redis, MinIO" }],
  },
];

describe("parseQuery", () => {
  it("splits on whitespace, lowercases and drops empties", () => {
    expect(parseQuery("  Foo  BAR ")).toEqual(["foo", "bar"]);
    expect(parseQuery("   ")).toEqual([]);
  });
});

describe("filterSections", () => {
  it("returns everything for an empty query", () => {
    expect(filterSections(SECTIONS, "")).toHaveLength(3);
  });

  it("matches titles, paragraphs, list items, glossary terms and diagram captions", () => {
    expect(filterSections(SECTIONS, "transcode").map((s) => s.id)).toEqual(["media"]);
    expect(filterSections(SECTIONS, "review").map((s) => s.id)).toEqual(["media"]);
    expect(filterSections(SECTIONS, "asynchronous").map((s) => s.id)).toEqual(["terms"]);
    expect(filterSections(SECTIONS, "minio").map((s) => s.id)).toEqual(["arch"]);
    expect(filterSections(SECTIONS, "glossary").map((s) => s.id)).toEqual(["terms"]);
  });

  it("matches at word starts only", () => {
    expect(filterSections(SECTIONS, "code")).toEqual([]);
    expect(filterSections(SECTIONS, "cod")).toEqual([]);
    expect(filterSections(SECTIONS, "ode")).toEqual([]);
    expect(filterSections(SECTIONS, "trans").map((s) => s.id)).toEqual(["media"]);
  });

  it("requires every word to match within the same section", () => {
    expect(filterSections(SECTIONS, "upload player").map((s) => s.id)).toEqual(["media"]);
    expect(filterSections(SECTIONS, "upload minio")).toEqual([]);
  });
});

describe("highlightParts", () => {
  it("marks matched fragments case-insensitively, escaping regex characters", () => {
    expect(highlightParts("Run SAM now", ["sam"])).toEqual([
      { text: "Run ", match: false },
      { text: "SAM", match: true },
      { text: " now", match: false },
    ]);
    expect(highlightParts("use (x) here", ["(x)"])).toEqual([
      { text: "use ", match: false },
      { text: "(x)", match: true },
      { text: " here", match: false },
    ]);
  });

  it("returns the text unchanged when there are no terms", () => {
    expect(highlightParts("hello", [])).toEqual([{ text: "hello", match: false }]);
  });
});

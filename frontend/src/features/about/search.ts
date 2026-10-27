export type Block =
  | { type: "p"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "terms"; items: { term: string; def: string }[] }
  | { type: "diagram"; id: "workflow" | "architecture"; caption: string };

export interface Section {
  id: string;
  title: string;
  /** One line shown under the heading. */
  lead?: string;
  blocks: Block[];
}

function blockText(block: Block): string[] {
  switch (block.type) {
    case "p":
      return [block.text];
    case "list":
      return block.items;
    case "table":
      return [...block.head, ...block.rows.flat()];
    case "terms":
      return block.items.flatMap((item) => [item.term, item.def]);
    case "diagram":
      return [block.caption];
  }
}

export function sectionText(section: Section): string {
  return [section.title, section.lead ?? "", ...section.blocks.flatMap(blockText)]
    .join(" ")
    .toLowerCase();
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Terms match at the start of a word, so "sam" finds SAM but not "same". */
const WORD_START = "(?<![\\p{L}\\p{N}])";

export function parseQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** A section matches when every query word occurs somewhere in it. */
export function filterSections(sections: Section[], query: string): Section[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return sections;
  return sections.filter((section) => {
    const text = sectionText(section);
    return terms.every((term) => new RegExp(WORD_START + escapeRegExp(term), "u").test(text));
  });
}

export interface TextPart {
  text: string;
  match: boolean;
}

export function highlightParts(text: string, terms: string[]): TextPart[] {
  if (terms.length === 0) return [{ text, match: false }];
  const pattern = new RegExp(
    `${WORD_START}(${terms.map(escapeRegExp).join("|")})`,
    "giu",
  );
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, match: terms.includes(part.toLowerCase()) }));
}

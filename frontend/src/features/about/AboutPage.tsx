import { useEffect, useMemo, useRef, useState } from "react";

import { SECTIONS } from "./aboutContent";
import { ArchitectureDiagram, WorkflowDiagram } from "./Diagrams";
import { filterSections, highlightParts, parseQuery, type Block } from "./search";

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded bg-yellow-400/30 px-0.5 text-yellow-100">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface BlockViewProps {
  block: Block;
  terms: string[];
  onSelectSection: (id: string) => void;
}

function BlockView({ block, terms, onSelectSection }: BlockViewProps) {
  switch (block.type) {
    case "p":
      return (
        <p className="text-sm leading-relaxed text-gray-300">
          <Highlight text={block.text} terms={terms} />
        </p>
      );
    case "list":
      return (
        <ul className="grid gap-3 lg:grid-cols-2">
          {block.items.map((item) => {
            const [head, ...rest] = item.split(": ");
            const hasHead = rest.length > 0 && head.length <= 32;
            return (
              <li
                key={item}
                className="rounded border border-gray-800 bg-gray-950 px-4 py-3 text-sm text-gray-300"
              >
                {hasHead ? (
                  <>
                    <div className="font-medium text-gray-100">
                      <Highlight text={head} terms={terms} />
                    </div>
                    <div className="mt-0.5 text-gray-400">
                      <Highlight text={capitalize(rest.join(": "))} terms={terms} />
                    </div>
                  </>
                ) : (
                  <Highlight text={item} terms={terms} />
                )}
              </li>
            );
          })}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-950 text-xs uppercase tracking-wide text-gray-400">
              <tr>
                {block.head.map((cell) => (
                  <th key={cell} className="px-4 py-2 font-medium">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row[0]} className="border-t border-gray-800">
                  {row.map((cell, i) => (
                    <td key={i} className={i === 0 ? "px-4 py-2 font-medium text-gray-100" : "px-4 py-2 text-gray-300"}>
                      <Highlight text={cell} terms={terms} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "terms":
      return (
        <dl className="grid gap-3 lg:grid-cols-2">
          {block.items.map((item) => (
            <div key={item.term} className="rounded border border-gray-800 bg-gray-950 px-4 py-3">
              <dt className="text-sm font-medium text-blue-300">
                <Highlight text={item.term} terms={terms} />
              </dt>
              <dd className="mt-0.5 text-sm text-gray-400">
                <Highlight text={item.def} terms={terms} />
              </dd>
            </div>
          ))}
        </dl>
      );
    case "diagram":
      return (
        <figure className="rounded border border-gray-800 bg-gray-950 p-4">
          {block.id === "workflow" ? (
            <WorkflowDiagram onSelect={onSelectSection} />
          ) : (
            <ArchitectureDiagram />
          )}
          <figcaption className="mt-3 text-xs text-gray-500">
            {block.id === "workflow" ? "Click a step to jump to its section." : "Simplified view of the running services."}
          </figcaption>
        </figure>
      );
  }
}

export function AboutPage() {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const searchRef = useRef<HTMLInputElement>(null);

  const terms = useMemo(() => parseQuery(query), [query]);
  const visible = useMemo(() => filterSections(SECTIONS, query), [query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      const isSlash = event.key === "/" && !typing;
      const isCtrlK = event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey);
      if (isSlash || isCtrlK) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((entry) => entry.isIntersecting);
        if (hit) setActiveId(hit.target.id.replace("about-", ""));
      },
      { rootMargin: "-10% 0px -75% 0px" },
    );
    visible.forEach((section) => {
      const el = document.getElementById(`about-${section.id}`);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [visible]);

  function goTo(id: string) {
    setActiveId(id);
    document.getElementById(`about-${id}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="bg-gray-950 p-8 text-gray-100">
      <header className="mb-8 rounded-lg border border-gray-800 bg-gradient-to-br from-gray-900 to-gray-950 p-8">
        <h1 className="text-3xl font-semibold">Endoscopy Annotation Platform</h1>
        <p className="mt-2 max-w-3xl text-gray-300">
          Annotate endoscopic video, build datasets and train and inspect computer-vision models —
          on your own hardware.
        </p>
        <div className="relative mt-6 max-w-xl">
          <input
            ref={searchRef}
            type="search"
            role="searchbox"
            aria-label="Search this page"
            placeholder="Search this page…  ( / )"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full rounded border border-gray-700 bg-gray-950 px-4 py-2 pr-10 text-sm text-gray-100 placeholder:text-gray-500 focus:border-blue-400 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-100"
            >
              ✕
            </button>
          )}
        </div>
        {query && (
          <p className="mt-2 text-xs text-gray-500">
            {visible.length} of {SECTIONS.length} sections match
          </p>
        )}
      </header>

      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav aria-label="On this page" className="sticky top-8 flex flex-col gap-1 text-sm">
            {visible.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => goTo(section.id)}
                aria-current={activeId === section.id ? "true" : undefined}
                className={
                  activeId === section.id
                    ? "rounded border-l-2 border-blue-400 bg-gray-900 px-3 py-1.5 text-left font-medium text-blue-300"
                    : "rounded border-l-2 border-transparent px-3 py-1.5 text-left text-gray-400 hover:text-gray-100"
                }
              >
                {section.title}
              </button>
            ))}
          </nav>
        </aside>

        <div className="space-y-6 pb-16">
          {visible.length === 0 && (
            <p className="rounded border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
              No results for “{query}”.
            </p>
          )}
          {visible.map((section) => (
            <section
              key={section.id}
              id={`about-${section.id}`}
              className="scroll-mt-8 rounded-lg border border-gray-800 bg-gray-900 p-6"
            >
              <h2 className="text-xl font-semibold text-gray-100">
                <Highlight text={section.title} terms={terms} />
              </h2>
              {section.lead && (
                <p className="mt-1 text-sm text-gray-400">
                  <Highlight text={section.lead} terms={terms} />
                </p>
              )}
              <div className="mt-5 space-y-4">
                {section.blocks.map((block, i) => (
                  <BlockView key={i} block={block} terms={terms} onSelectSection={goTo} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

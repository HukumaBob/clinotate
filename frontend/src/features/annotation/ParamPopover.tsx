import { useEffect, useRef, useState, type ReactNode } from "react";

interface ParamPopoverProps {
  /** Accessible name and visible text of the button that opens the popover. */
  label: string;
  runningLabel: string;
  isRunning: boolean;
  description: string;
  onRun: () => void;
  children: ReactNode;
}

/**
 * A toolbar button that opens a small panel holding the action's parameters
 * (with labels and an explanation) and a Run button, so the bar itself stays
 * free of unlabeled number fields.
 */
export function ParamPopover({ label, runningLabel, isRunning, description, onRun, children }: ParamPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen]);

  function handleRun() {
    setIsOpen(false);
    onRun();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        disabled={isRunning}
        className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
      >
        {isRunning ? runningLabel : `${label}…`}
      </button>
      {isOpen && (
        <div className="absolute left-0 top-full z-20 mt-2 w-72 space-y-3 rounded border border-gray-700 bg-gray-900 p-4 text-sm text-gray-200 shadow-xl">
          <p className="text-gray-400">{description}</p>
          {children}
          <button
            type="button"
            aria-label={`Run ${label}`}
            onClick={handleRun}
            className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
          >
            Run
          </button>
        </div>
      )}
    </div>
  );
}

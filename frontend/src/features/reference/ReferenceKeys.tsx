import { colorForClass } from "../qc/predictions";
import type { RefAxis } from "./types";

interface ReferenceKeysProps {
  axes: RefAxis[];
  onPress: (categoryId: number, labelId: number) => void;
}

/** The legend: one row of class chips per axis. A chip shows its key and
 * name and does what the key does when clicked. */
export function ReferenceKeys({ axes, onPress }: ReferenceKeysProps) {
  return (
    <div className="flex flex-col gap-2">
      {axes.map((axis) => (
        <div key={axis.categoryId} className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 truncate text-xs text-gray-400">{axis.name}</span>
          {axis.classes.map((cls) => (
            <button
              key={cls.labelId}
              type="button"
              title={cls.key === null ? "No key: click to use" : undefined}
              onClick={() => onPress(axis.categoryId, cls.labelId)}
              className="flex items-center gap-1.5 rounded border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-200 hover:border-gray-500"
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: colorForClass(cls.labelId) }}
              />
              <kbd
                className={`font-mono ${cls.key === null ? "text-gray-600" : "text-gray-100"}`}
              >
                {cls.key ?? "–"}
              </kbd>
              <span>{cls.name}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

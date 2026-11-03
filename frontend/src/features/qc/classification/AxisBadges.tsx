import { colorForClass } from "../predictions";
import { useVideoClock } from "../useVideoClock";
import { labelAt, type AxisIndex } from "./axisIndex";
import type { ClassificationDocument } from "./types";

interface AxisBadgesProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  indexes: AxisIndex[];
  axes: ClassificationDocument["axes"];
}

/** One chip per axis over the video's top-left corner: the label of the
 * processed frame at or before the current time and its confidence. An axis
 * has no chip before its first processed frame. */
export function AxisBadges({ videoRef, indexes, axes }: AxisBadgesProps) {
  const timeMs = useVideoClock(videoRef);

  return (
    <div className="pointer-events-none absolute left-2 right-2 top-2 flex flex-wrap gap-1.5">
      {axes.map((axis, i) => {
        const index = indexes[i];
        const label = index ? labelAt(index, timeMs) : null;
        if (!label) return null;
        const name = axis.classes[label.classId] ?? `class ${label.classId}`;
        const text = `${name} ${Math.round(label.confidence * 100)}%`;
        return (
          <span
            key={i}
            title={`${axis.name}: ${text}`}
            className="pointer-events-auto flex max-w-[14rem] items-center gap-1.5 rounded bg-gray-900/85 px-2 py-0.5 text-xs text-gray-100"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: colorForClass(label.classId) }}
            />
            <span className="truncate">{text}</span>
          </span>
        );
      })}
    </div>
  );
}

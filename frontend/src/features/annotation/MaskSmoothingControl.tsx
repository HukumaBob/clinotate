import { useEffect, useRef, useState } from "react";

import { useReapplyMaskPostprocess } from "../../entities/useMaskPostprocess";

interface MaskSmoothingControlProps {
  annotationId: number;
  initialStrength: number | null;
  frameId: number;
}

const DEBOUNCE_MS = 300;

export function MaskSmoothingControl({ annotationId, initialStrength, frameId }: MaskSmoothingControlProps) {
  const [strength, setStrength] = useState(initialStrength ?? 0);
  const reapply = useReapplyMaskPostprocess(frameId);
  const debounceTimer = useRef<number | null>(null);

  // Only re-seed from a genuinely new prop value (e.g. after this
  // control's own mutation invalidates the annotations query and the
  // server echoes back the strength this component just set) -- not on
  // every parent re-render, which would otherwise fight the user's
  // in-progress drag.
  const lastSeenInitial = useRef(initialStrength);
  useEffect(() => {
    if (initialStrength !== lastSeenInitial.current) {
      lastSeenInitial.current = initialStrength;
      setStrength(initialStrength ?? 0);
    }
  }, [initialStrength]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    };
  }, []);

  function handleChange(value: number) {
    setStrength(value);
    if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      reapply.mutate({ annotationId, strength: value });
    }, DEBOUNCE_MS);
  }

  return (
    <label className="flex items-center gap-1 text-[11px] text-gray-500">
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={strength}
        aria-label="Smoothing"
        onChange={(event) => handleChange(Number(event.target.value))}
        onClick={(event) => event.stopPropagation()}
        className="w-16"
      />
    </label>
  );
}

export function CropOverlay({
  crop,
  mediaRect,
}: {
  crop: { left: number; right: number; top: number; bottom: number };
  mediaRect?: { left: number; top: number; width: number; height: number };
}) {
  const rootStyle = mediaRect
    ? {
        left: `${mediaRect.left}px`,
        top: `${mediaRect.top}px`,
        width: `${mediaRect.width}px`,
        height: `${mediaRect.height}px`,
      }
    : undefined;

  return (
    <div
      data-testid="crop-overlay-root"
      className={`pointer-events-none absolute${mediaRect ? "" : " inset-0"}`}
      style={rootStyle}
    >
      <div
        data-testid="crop-overlay-left"
        className="absolute inset-y-0 left-0 bg-black/60"
        style={{ width: `${crop.left}%` }}
      />
      <div
        data-testid="crop-overlay-right"
        className="absolute inset-y-0 right-0 bg-black/60"
        style={{ width: `${crop.right}%` }}
      />
      <div
        data-testid="crop-overlay-top"
        className="absolute inset-x-0 top-0 bg-black/60"
        style={{ height: `${crop.top}%` }}
      />
      <div
        data-testid="crop-overlay-bottom"
        className="absolute inset-x-0 bottom-0 bg-black/60"
        style={{ height: `${crop.bottom}%` }}
      />
      <div
        data-testid="crop-overlay-border"
        className="absolute border-2 border-yellow-400"
        style={{
          left: `${crop.left}%`,
          right: `${crop.right}%`,
          top: `${crop.top}%`,
          bottom: `${crop.bottom}%`,
        }}
      />
    </div>
  );
}

export function CropOverlay({
  crop,
}: {
  crop: { left: number; right: number; top: number; bottom: number };
}) {
  return (
    <div className="pointer-events-none absolute inset-0">
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

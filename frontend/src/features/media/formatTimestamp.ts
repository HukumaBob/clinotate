export function formatTimestamp(totalSeconds: number): string {
  const whole = Math.trunc(totalSeconds);
  const minutes = Math.trunc(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

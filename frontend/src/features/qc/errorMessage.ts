/** Turns an apiClient error body into text: FastAPI sends `detail` as a
 * string for HTTPException and as an array of `{msg, ...}` for a 422. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((item) => (item && typeof item === "object" ? (item as { msg?: unknown }).msg : undefined))
        .filter((msg): msg is string => typeof msg === "string");
      if (msgs.length > 0 && msgs.length === detail.length) return msgs.join("; ");
    }
  }
  return fallback;
}

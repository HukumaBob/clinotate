// FastAPI's error response shape varies by failure mode: a plain string
// `detail` for most `HTTPException`s (e.g. `{"detail": "Admin role required"}`),
// but a *list* of validation-error objects for 422s raised by Pydantic, e.g.
// `{"detail": [{"type": "greater_than_equal", "loc": [...], "msg": "...", ...}]}`.
// `openapi-fetch` passes the parsed body through verbatim with no coercion,
// so callers that assume `detail` is always a string will crash when React
// tries to render an array of objects as a child. Route every mutation error
// through this helper instead of reading `.detail` directly.
export function errorDetail(error: unknown, fallback: string): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (item as { msg?: string } | undefined)?.msg)
      .filter((msg): msg is string => Boolean(msg));
    return messages.length > 0 ? messages.join("; ") : fallback;
  }
  return fallback;
}

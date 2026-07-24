export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch {
    // Network-level failure: fetch REJECTED with no response at all — the
    // server restarting/unreachable, a dropped connection, or a stale app
    // bundle calling a route the new server no longer serves. The error /
    // errors[] body handling below can't run without a response, so surface
    // an actionable message rather than a raw "Failed to fetch". (v1.1.6)
    throw new ApiError(
      "Couldn't reach the server — it may be restarting, or your browser has an older version of the app loaded. Reload the page.",
      0,
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Surface a field-level reason from EITHER convention the API uses: a single
    // `error` string, or an `errors: string[]` list (validate/generate/apply).
    // Without this an endpoint that only returns `errors` shows a bare
    // "Request failed (HTTP 400)" and swallows the actual reason.
    const b = body as { error?: string; errors?: unknown } | null;
    const listed = Array.isArray(b?.errors) ? b!.errors.filter((x): x is string => typeof x === 'string') : [];
    const message = b?.error ?? (listed.length ? listed.join('; ') : null) ?? `Request failed (HTTP ${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  put: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(data) }),
  del: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'DELETE', body: data === undefined ? undefined : JSON.stringify(data) }),
};

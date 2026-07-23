export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
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

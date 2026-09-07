import type { ApiErrorBody } from '@flowza/contracts';
import { supabase } from './supabase.js';
import { env } from './env.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Status used for failures that never produced an HTTP response at all — DNS, TLS, connection refused, a timeout, or
 * a CORS rejection. `fetch` reports every one of these as an opaque `TypeError`, so without this they would surface as
 * a non-`ApiError` and skip every `instanceof ApiError` branch in the UI (including the MFA gate).
 */
export const NETWORK_ERROR_STATUS = 0;

/**
 * True for the 403 the API returns when the session must step up to `aal2` (apps/api `middleware/mfa.ts`):
 * either the organisation requires MFA, or the caller is a platform admin, who is gated on every route.
 */
export function isMfaRequiredError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.details?.reason === 'MFA_REQUIRED';
}

/** True when the API could not be reached at all, as opposed to answering with an error. */
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.status === NETWORK_ERROR_STATUS;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function apiFetch<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  const url = new URL(`${env.apiUrl}/api/v1${path}`);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const token = await accessToken();
  const headers = new Headers(opts.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (opts.idempotencyKey) headers.set('Idempotency-Key', opts.idempotencyKey);
  let res: Response;
  try {
    res = await fetch(url, { ...opts, headers, body: opts.body instanceof FormData ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch (cause) {
    // No response at all. Carry the API origin in the message: there is no request id to quote, and "which host could
    // I not reach" is the only actionable detail a user or a support ticket can act on.
    throw new ApiError(NETWORK_ERROR_STATUS, 'NETWORK_ERROR', `Could not reach the API at ${env.apiUrl}`, undefined, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // A proxy between the browser and the API (Cloudflare 5xx, a captive portal) answers with HTML, so parsing must not
  // be allowed to throw a SyntaxError over the real status — the status is the useful part.
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    if (res.ok) throw new ApiError(res.status, 'INVALID_RESPONSE', 'The API returned a malformed response', undefined, { bodyPreview: text.slice(0, 200) });
  }
  if (!res.ok) {
    const err = (json ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? res.statusText, err.requestId, err.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, query?: ApiRequestOptions['query']) => apiFetch<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, opts?: ApiRequestOptions) => apiFetch<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

export interface Envelope<T> { data: T; meta?: Record<string, unknown> }
export interface PageEnvelope<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }

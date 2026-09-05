import type { ApiErrorBody } from '@flowza/contracts';
import { supabase } from './supabase.js';
import { env } from './env.js';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
  }
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
  const res = await fetch(url, { ...opts, headers, body: opts.body instanceof FormData ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
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

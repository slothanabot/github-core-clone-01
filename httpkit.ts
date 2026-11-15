// Shared HTTP plumbing for the forge's handlers: one context object, JSON
// replies, raw replies, and the bearer-token gate.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Vault } from './vault.ts';

export interface Ctx {
  vault: Vault;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  body: Buffer;
  /** The shop token the trial expects ('' when unset: no gate). */
  shopToken: string;
  requestId: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(text);
}

export function sendRaw(ctx: Ctx, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(body);
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** The bearer token gate: every API surface refuses a missing/wrong token. */
export function authed(ctx: Ctx): boolean {
  if (ctx.shopToken === '') return true;
  const header = ctx.req.headers.authorization ?? '';
  return header === `Bearer ${ctx.shopToken}`;
}

export function requireAuth(ctx: Ctx): boolean {
  if (authed(ctx)) return true;
  sendError(ctx, 401, 'Requires authentication');
  return false;
}

/** Read a request body fully (bounded: 64 MiB is far above any pack the suite sends). */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body; null when the body is not valid JSON. */
export function parseJsonBody(ctx: Ctx): unknown | null {
  if (ctx.body.length === 0) return null;
  try {
    return JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return null;
  }
}

/** Split a comma-joined header value the way GitHub paginates (Link). */
export function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/** Build a same-origin Link header for a paginated list. */
export function linkHeader(ctx: Ctx, page: number, perPage: number, totalPages: number): string {
  const host = ctx.req.headers.host ?? 'localhost';
  const base = `http://${host}${ctx.path}`;
  const links: string[] = [];
  const url = (p: number): string => `${base}?${new URLSearchParams({ page: String(p), per_page: String(perPage) }).toString()}`;
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(Math.max(1, totalPages))}>; rel="last"`);
  return links.join(', ');
}

/** Paginate an array; returns the page slice and the total page count. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages };
}

// Shared low-level helpers for the forge: hashing, base64, pkt-lines, ids.
// No dependency beyond node:crypto / node:zlib consumers.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

/** SHA-1 of a git object header + payload: sha1("<type> <size>\0" + data). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** SHA-1 of raw bytes (pack trailer, etc). */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** Opaque, stable Relay-style global id: base64("Kind:payload"). Never the raw number. */
export function globalId(kind: string, payload: string): string {
  return b64encode(`${kind}:${payload}`);
}

/** Decode a global id made by globalId(); null when it is not one. */
export function parseGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id.replace(/\s+/g, ''), 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Cursor for connection pagination: base64("cur:<number>"). */
export function encodeCursor(n: number): string {
  return b64encode(`cur:${n}`);
}

export function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (!text.startsWith('cur:')) return null;
    const n = Number(text.slice(4));
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Monotonic epoch seconds for commit identities (never goes backwards). */
export function makeClock(): () => number {
  let last = Math.floor(Date.now() / 1000);
  return () => {
    const now = Math.floor(Date.now() / 1000);
    last = Math.max(now, last + 1);
    return last;
  };
}

/** One pkt-line: 4 hex length bytes + payload. 'flush' | 'delim' | 'response-end' are controls. */
export function pktLine(payload: string | Buffer | 'flush' | 'delim' | 'response-end'): Buffer {
  if (payload === 'flush') return Buffer.from('0000', 'ascii');
  if (payload === 'delim') return Buffer.from('0001', 'ascii');
  if (payload === 'response-end') return Buffer.from('0002', 'ascii');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > 65520) throw new Error('pkt-line too long');
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  return Buffer.concat(items.map((item) => pktLine(item)));
}

/** A sideband packet: pkt-line framing with a band byte (1 pack, 2 progress, 3 error). */
export function sideband(band: 1 | 2 | 3, data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return pktLine(Buffer.concat([Buffer.from([band]), body]));
}

/** Split a buffer into pkt-line frames: {kind:'data', data} | {kind:'flush'|'delim'|'response-end'}. */
export function splitPktLines(
  buf: Buffer,
): { frames: { kind: 'data' | 'flush' | 'delim' | 'response-end'; data?: Buffer }[]; rest: Buffer } {
  const frames: { kind: 'data' | 'flush' | 'delim' | 'response-end'; data?: Buffer }[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      frames.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      frames.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      frames.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    frames.push({ kind: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { frames, rest: buf.subarray(offset) };
}

/** Escape a string for safe inclusion in a JSON text block (MCP tool results). */
export function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

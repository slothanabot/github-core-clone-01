// Git objects: hashing, commit/tree/tag parse + build, packfile codec,
// reachability, fast-forward checks, and fetch planning.
//
// All object bytes are handled exactly as the git format defines them; the
// pack writer emits plain (undeltad) objects only, which the client accepts.

import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, sha1Hex, ZERO_OID, isOid } from './util.ts';
import type { GitObject, ObjectType, RepoRecord } from './vault.ts';

export const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------- commits

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extraHeaders: string[];
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  const extraHeaders: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.length > 0) extraHeaders.push(line);
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree');
  return { tree, parents, author, committer, message, extraHeaders };
}

export function buildCommit(parts: CommitParts): Buffer {
  const lines = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`);
  lines.push(`committer ${parts.committer}`);
  for (const extra of parts.extraHeaders) lines.push(extra);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree entry');
    const nul = data.indexOf(0x00, space);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface TagParts {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- trees from file maps

/** Store a tree built from path -> blob oid, bottom-up; returns the root tree oid. */
export function materializeTree(repo: RepoRecord, files: Map<string, string>): string {
  // Group paths by directory.
  const byDir = new Map<string, Map<string, string>>(); // dir -> (name -> oid or subdir marker)
  const dirs = new Set<string>(['']);
  for (const path of files.keys()) {
    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix === '' ? parts[i]! : `${prefix}/${parts[i]!}`;
      dirs.add(prefix);
    }
  }
  const dirOf = (path: string): string => {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
  };
  const baseOf = (path: string): string => {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? path : path.slice(idx + 1);
  };
  const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
  // Deepest directories first, so every sub-tree exists before its parent
  // is built. (''.split('/') is [''], length 1 — the root must count as 0.)
  const ordered = [...dirs].sort((a, b) => depthOf(b) - depthOf(a));
  const treeOidByDir = new Map<string, string>();
  for (const dir of ordered) {
    const entries: TreeEntry[] = [];
    for (const [path, oid] of files) {
      if (dirOf(path) === dir) entries.push({ mode: '100644', name: baseOf(path), oid });
    }
    for (const sub of dirs) {
      if (dirOf(sub) === dir && sub !== '') {
        const subOid = treeOidByDir.get(sub);
        if (subOid) entries.push({ mode: '40000', name: baseOf(sub), oid: subOid });
      }
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    treeOidByDir.set(dir, oid);
  }
  return treeOidByDir.get('') ?? hashObject('tree', buildTree([]));
}

/** Flatten a tree to path -> {oid, mode}, recursively. */
export function flattenTree(repo: RepoRecord, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(repo, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

// ---------------------------------------------------------------- reachability

/** Peel a tag (recursively) to its commit, or return the oid itself when it is one. */
export function peelToCommit(repo: RepoRecord, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All objects reachable from the tips (commits, tags, trees, blobs). */
export function collectReachable(repo: RepoRecord, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const parts = parseCommit(obj.data);
      stack.push(parts.tree);
      for (const parent of parts.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (tags peeled). Same oid counts. */
export function isAncestor(repo: RepoRecord, ancestor: string, descendant: string): boolean {
  const descCommit = peelToCommit(repo, descendant);
  const ancCommit = peelToCommit(repo, ancestor);
  if (!descCommit || !ancCommit) return false;
  if (descCommit === ancCommit) return true;
  const seen = new Set<string>();
  const stack = [descCommit];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancCommit) return true;
      stack.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------- packfiles

/** Delta-stream varint (7 bits per byte, little-endian groups). */
function readDeltaVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = offset;
  for (;;) {
    const byte = data[next]!;
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const sourceSize = readDeltaVarint(delta, 0);
  if (sourceSize.value !== base.length) throw new Error('delta source size mismatch');
  const targetSize = readDeltaVarint(delta, sourceSize.next);
  const out: Buffer[] = [];
  let written = 0;
  let offset = targetSize.next;
  while (offset < delta.length) {
    const opcode = delta[offset]!;
    offset += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((opcode & (1 << i)) !== 0) {
          copyOffset |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((opcode & (0x10 << i)) !== 0) {
          copySize |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (opcode !== 0) {
      const size = opcode & 0x7f;
      if (offset + size > delta.length) throw new Error('delta insert out of range');
      out.push(delta.subarray(offset, offset + size));
      offset += size;
      written += size;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Inflate the zlib stream starting at `offset` and report where it ends.
 * inflateSync ignores trailing bytes but throws on truncation, so the stream's
 * true end is the smallest prefix length that inflates cleanly (binary search).
 */
function inflateAt(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const max = pack.length - offset;
  let lo = 1;
  let hi = max;
  try {
    inflateSync(pack.subarray(offset, offset + hi));
  } catch {
    throw new Error('bad zlib stream in pack');
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(pack.subarray(offset, offset + lo)), next: offset + lo };
}

export interface ParsedPack {
  version: number;
  objects: Map<string, GitObject>;
}

interface RawPackEntry {
  offset: number;
  type: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile: verify the trailer, inflate entries, resolve deltas
 * (ofs chains and ref-deltas, the latter via `resolveBase` for thin packs),
 * and verify every object hashes to its id.
 */
export function parsePack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ParsedPack {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) throw new Error('pack checksum mismatch');
  const raw: RawPackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const first = pack[offset]!;
    offset += 1;
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while ((pack[offset - 1]! & 0x80) !== 0) {
      const byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      let value = pack[offset]!;
      offset += 1;
      while ((pack[offset - 1]! & 0x80) !== 0) {
        const byte = pack[offset]!;
        offset += 1;
        value = ((value + 1) << 7) + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
      if (baseOffset <= 0 || baseOffset >= entryOffset) throw new Error('bad ofs-delta base');
    } else if (type === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPES[type] === undefined) {
      throw new Error(`unknown pack object type ${type}`);
    }
    const { data, next } = inflateAt(pack, offset);
    if (data.length !== size) throw new Error('pack object size mismatch');
    offset = next;
    raw.push({ offset: entryOffset, type, size, data, baseOffset, baseOid });
  }
  const byOffset = new Map<number, RawPackEntry>(raw.map((entry) => [entry.offset, entry]));
  const resolved = new Map<string, GitObject>();
  const resolveOne = (entry: RawPackEntry, seen: Set<number>): GitObject => {
    if (entry.type === 6 || entry.type === 7) {
      if (seen.has(entry.offset)) throw new Error('pack delta cycle');
      seen.add(entry.offset);
      let base: GitObject | undefined;
      let baseOid: string | undefined;
      if (entry.type === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        base = resolveOne(baseEntry, seen);
        baseOid = hashObject(base.type, base.data);
      } else {
        baseOid = entry.baseOid!;
        // The base may be an earlier entry in this pack, or external (thin pack).
        for (const candidate of raw) {
          if (candidate.type !== 6 && candidate.type !== 7) {
            const oid = hashObject(CODE_TYPES[candidate.type]!, candidate.data);
            if (oid === baseOid) {
              base = { type: CODE_TYPES[candidate.type]!, data: candidate.data };
              break;
            }
          }
        }
        if (!base && resolveBase) base = resolveBase(baseOid);
        if (!base) throw new Error(`ref-delta base ${baseOid} not available`);
      }
      const data = applyDelta(base.data, entry.data);
      const type = base.type;
      const oid = hashObject(type, data);
      const obj: GitObject = { type, data };
      resolved.set(oid, obj);
      return obj;
    }
    const type = CODE_TYPES[entry.type]!;
    const oid = hashObject(type, entry.data);
    const obj: GitObject = { type, data: entry.data };
    resolved.set(oid, obj);
    return obj;
  };
  for (const entry of raw) resolveOne(entry, new Set<number>());
  return { version, objects: resolved };
}

/** Encode a type+size object header varint. */
function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, plain objects only, no deltas) with trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** An empty pack (zero objects), used when a fetch has nothing new to send. */
export function emptyPack(): Buffer {
  return writePack([]);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Objects to send, in send order. */
  objects: GitObject[];
  /** New shallow boundary commits (depth cut). */
  shallow: string[];
  /** Requested shallow commits that are no longer shallow. */
  unshallow: string[];
}

/**
 * Decide what a fetch sends.
 *
 * - `wants`: oids the client asked for; `haves`: oids it already holds fully;
 *   `shallow`: its current shallow boundaries (their parents are NOT held);
 *   `depth`: null for a full fetch, else max generations from a want.
 * - A commit reachable from a have is excluded, except past a shallow
 *   boundary: ancestors of a shallow commit are not held, so they are not
 *   excluded. Depth cuts mark new shallow boundaries; a requested shallow
 *   commit whose parent is now included becomes unshallow.
 */
export function planFetch(
  repo: RepoRecord,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallow.filter((oid) => isOid(oid)));
  // Commits excluded as already held: closure from haves, stopping at shallow
  // boundaries (their ancestors are not held).
  const excluded = new Set<string>();
  {
    const stack = haves.map((oid) => peelToCommit(repo, oid)).filter((oid): oid is string => oid !== null);
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (excluded.has(oid)) continue;
      excluded.add(oid);
      if (shallowSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  // Objects the client already holds: everything reachable from a have
  // commit (commit + its tree closure), stopping at shallow boundaries —
  // ancestors of a shallow commit are NOT held. The fetch must not re-send
  // any of these, even blobs/trees shared with the new tip.
  const excludedObjects = new Set<string>();
  {
    const seenCommits = new Set<string>();
    const stack = haves.map((oid) => peelToCommit(repo, oid)).filter((oid): oid is string => oid !== null);
    while (stack.length > 0) {
      const commit = stack.pop()!;
      if (seenCommits.has(commit)) continue;
      seenCommits.add(commit);
      const obj = repo.objects.get(commit);
      if (!obj || obj.type !== 'commit') continue;
      excludedObjects.add(commit);
      for (const oid of collectReachable(repo, [parseCommit(obj.data).tree])) excludedObjects.add(oid);
      if (shallowSet.has(commit)) continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  // Expand wants: tags contribute their target as a seed; plain commits seed BFS.
  const seeds: { commit: string; depth: number }[] = [];
  const directObjects = new Set<string>();
  for (const want of wants) {
    if (!isOid(want)) continue;
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      directObjects.add(want);
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (!targetObj) continue;
      if (targetObj.type === 'commit') seeds.push({ commit: target, depth: 0 });
      else directObjects.add(target);
    } else if (obj.type === 'commit') {
      seeds.push({ commit: want, depth: 0 });
    } else {
      directObjects.add(want);
    }
  }
  // BFS over commits with depth tracking; include non-excluded commits within depth.
  const minDepth = new Map<string, number>();
  const included = new Set<string>();
  const queue: { commit: string; depth: number }[] = [...seeds];
  while (queue.length > 0) {
    const { commit, depth: d } = queue.shift()!;
    const prev = minDepth.get(commit);
    if (prev !== undefined && prev <= d) continue;
    minDepth.set(commit, d);
    if (!excluded.has(commit) && (depth === null || d < depth)) included.add(commit);
    // Always walk parents (minDepth guards revisits): the shallow computation
    // below needs the depth of cut-off parents too.
    const obj = repo.objects.get(commit);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      queue.push({ commit: parent, depth: d + 1 });
    }
  }
  // New shallow boundaries: included commits with a parent cut by the depth limit.
  const shallowOut: string[] = [];
  if (depth !== null) {
    for (const commit of included) {
      const obj = repo.objects.get(commit);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        const parentDepth = minDepth.get(parent);
        if (parentDepth !== undefined && parentDepth >= depth && !included.has(parent)) {
          shallowOut.push(commit);
          break;
        }
      }
    }
  }
  // Unshallow: a requested shallow commit whose parent is now included.
  const unshallowOut: string[] = [];
  for (const oid of shallowSet) {
    const commit = peelToCommit(repo, oid);
    if (!commit) continue;
    const obj = repo.objects.get(commit);
    if (!obj || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.some((parent) => included.has(parent))) {
      unshallowOut.push(oid);
    }
  }
  // Object closure over included commits (trees + blobs), tags, and direct objects.
  // Anything the client already holds is left out, even when shared with the new tip.
  const send = new Set<string>(directObjects);
  for (const commit of included) {
    send.add(commit);
    const obj = repo.objects.get(commit);
    if (!obj || obj.type !== 'commit') continue;
    const treeOid = parseCommit(obj.data).tree;
    for (const oid of collectReachable(repo, [treeOid])) {
      if (!excludedObjects.has(oid)) send.add(oid);
    }
  }
  // Tags in `send` need their target closure too (target commit already seeded,
  // but a tag to a tree/blob needs the target object itself).
  for (const oid of [...send]) {
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      send.add(target);
      const targetObj = repo.objects.get(target);
      if (targetObj && targetObj.type === 'tree') {
        for (const sub of collectReachable(repo, [target])) send.add(sub);
      }
    }
  }
  const objects: GitObject[] = [];
  // Deterministic send order: commits, then tags, then trees, then blobs.
  const byType: Record<string, GitObject[]> = { commit: [], tag: [], tree: [], blob: [] };
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) byType[obj.type]!.push(obj);
  }
  objects.push(...byType.commit!, ...byType.tag!, ...byType.tree!, ...byType.blob!);
  return { objects, shallow: shallowOut, unshallow: unshallowOut };
}

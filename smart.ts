// Git smart HTTP: info/refs advertisements (protocol v0 and v2), upload-pack
// (clone/fetch, v0 and v2 with ls-refs), and receive-pack (push, v0).
//
// Implemented from the git wire format alone: pkt-line framing, sideband
// multiplexing, packfiles (see gitobj.ts). No git binary anywhere.

import { pktLine, pktLines, sideband, splitPktLines, ZERO_OID, isOid } from './util.ts';
import type { Ctx } from './httpkit.ts';
import { requireAuth, sendError, sendRaw } from './httpkit.ts';
import type { RepoRecord } from './vault.ts';
import {
  collectReachable,
  isAncestor,
  parsePack,
  parseTag,
  peelToCommit,
  planFetch,
  writePack,
  emptyPack,
} from './gitobj.ts';

const UPLOAD_CAPS_V0 =
  'side-band-64k ofs-delta thin-pack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
const RECEIVE_CAPS_V0 =
  'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1';
const AGENT = 'forge/1.0';

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function sortedRefs(repo: RepoRecord): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headOid(repo: RepoRecord): string {
  return repo.refs.get('refs/heads/main') ?? ZERO_OID;
}

/** Peeled commit for an annotated tag ref, or null. */
function peeledOid(repo: RepoRecord, ref: string, oid: string): string | null {
  if (!ref.startsWith('refs/tags/')) return null;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const target = parseTag(obj.data).object;
  const commit = peelToCommit(repo, target);
  return commit ?? target;
}

function v0Advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), pktLine('flush')];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) {
      lines.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.name, ref.oid);
      if (peeled) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  lines.push(pktLine('flush'));
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', `agent=${AGENT}\n`, 'object-format=sha1\n', 'flush']);
}

function handleInfoRefs(ctx: Ctx, owner: string, name: string): boolean {
  const service = ctx.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const repo = ctx.vault.getRepo(owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    sendRaw(ctx, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
  } else {
    const contentType =
      service === 'git-upload-pack'
        ? 'application/x-git-upload-pack-advertisement'
        : 'application/x-git-receive-pack-advertisement';
    sendRaw(ctx, 200, contentType, v0Advertisement(repo, service));
  }
  return true;
}

// ---------------------------------------------------------------- upload-pack (v2)

function handleUploadPackV2(ctx: Ctx, repo: RepoRecord): void {
  const { frames } = splitPktLines(ctx.body);
  const lines: string[] = [];
  for (const frame of frames) {
    if (frame.kind === 'data' && frame.data) lines.push(frame.data.toString('utf8'));
  }
  const commandLine = lines[0] ?? '';
  if (commandLine.startsWith('command=ls-refs')) {
    handleLsRefs(ctx, repo, lines.slice(1));
    return;
  }
  if (commandLine.startsWith('command=fetch')) {
    handleFetchV2(ctx, repo, lines.slice(1));
    return;
  }
  sendError(ctx, 400, 'unknown command');
}

function handleLsRefs(ctx: Ctx, repo: RepoRecord, args: string[]): void {
  let peel = true;
  let symrefs = true;
  let unborn = true;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.trim();
    if (line === 'peel') peel = true;
    else if (line === 'unborn') unborn = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('ref-prefix\t')) prefixes.push(line.slice('ref-prefix\t'.length));
  }
  const out: Buffer[] = [];
  const refs = sortedRefs(repo);
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const head = headOid(repo);
  if (matches('HEAD') && symrefs) {
    if (head === ZERO_OID) {
      if (unborn) out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      out.push(pktLine(`${head} HEAD symref-target:refs/heads/main\n`));
    }
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.name, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktLine('flush'));
  sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

function handleFetchV2(ctx: Ctx, repo: RepoRecord, args: string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of args) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
  const out: Buffer[] = [];
  out.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine('delim'));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(pktLine('delim'));
  }
  out.push(pktLine('wanted-refs\n'));
  for (const want of wants) {
    const names = sortedRefs(repo)
      .filter((ref) => ref.oid === want)
      .map((ref) => ref.name);
    if (names.length > 0) {
      for (const name of names) out.push(pktLine(`${want} ${name}\n`));
    } else {
      out.push(pktLine(`${want}\n`));
    }
  }
  out.push(pktLine('delim'));
  out.push(pktLine('packfile\n'));
  // Chunk the pack into sideband packets (pkt-line payload cap 65516, minus band byte).
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    out.push(sideband(1, pack.subarray(offset, offset + CHUNK)));
  }
  out.push(pktLine('flush'));
  sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------- upload-pack (v0)

function handleUploadPackV0(ctx: Ctx, repo: RepoRecord): void {
  const { frames } = splitPktLines(ctx.body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const frame of frames) {
    if (frame.kind !== 'data' || !frame.data) continue;
    let line = frame.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    line = line.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = plan.objects.length === 0 ? emptyPack() : writePack(plan.objects);
  const out: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    out.push(sideband(1, pack.subarray(offset, offset + CHUNK)));
  }
  out.push(pktLine('flush'));
  sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------- receive-pack (push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: Ctx, repo: RepoRecord): void {
  const { frames, rest } = splitPktLines(ctx.body);
  const commands: PushCommand[] = [];
  let useV2 = false;
  let useSideband = false;
  let unpackError: string | null = null;
  for (const frame of frames) {
    if (frame.kind === 'flush') break;
    if (frame.kind !== 'data' || !frame.data) continue;
    let line = frame.data.toString('utf8');
    let caps = '';
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    if (caps !== '') {
      const tokens = caps.trim().split(/\s+/);
      if (tokens.includes('report-status-v2')) useV2 = true;
      if (tokens.includes('side-band-64k')) useSideband = true;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  void useV2;
  // The packfile follows the command flush as raw bytes.
  const needsPack = commands.some((cmd) => cmd.newOid !== ZERO_OID);
  let parsedObjects: Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> | null = null;
  if (needsPack) {
    if (rest.length === 0) {
      unpackError = 'no packfile received';
    } else {
      try {
        const parsed = parsePack(rest, (oid) => repo.objects.get(oid));
        parsedObjects = parsed.objects;
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  if (!unpackError && parsedObjects) {
    for (const [oid, obj] of parsedObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const reportLines: string[] = [];
  if (unpackError) {
    reportLines.push(`unpack ${unpackError}`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed`);
  } else {
    reportLines.push('unpack ok');
    for (const cmd of commands) {
      const verdict = applyRefUpdate(repo, cmd);
      reportLines.push(verdict.ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${verdict.reason}`);
    }
  }
  const out: Buffer[] = [];
  if (useSideband) {
    for (const line of reportLines) out.push(sideband(1, `${line}\n`));
  } else {
    for (const line of reportLines) out.push(pktLine(`${line}\n`));
  }
  out.push(pktLine('flush'));
  sendRaw(ctx, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}

function applyRefUpdate(repo: RepoRecord, cmd: PushCommand): { ok: boolean; reason?: string } {
  const { oldOid, newOid, ref } = cmd;
  if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\x00-\x1f\x7f]/.test(ref)) {
    return { ok: false, reason: 'invalid ref' };
  }
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    repo.log(`ref-delete ${ref}`);
    return { ok: true };
  }
  const target = repo.objects.get(newOid);
  if (!target) return { ok: false, reason: 'object not found' };
  if (oldOid !== ZERO_OID) {
    // Fast-forward only: the new tip must descend from the old one.
    if (!isAncestor(repo, oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  repo.log(`ref-update ${ref} ${oldOid.slice(0, 7)}..${newOid.slice(0, 7)}`);
  return { ok: true };
}

// ---------------------------------------------------------------- entry

/** Handle /<owner>/<repo>.git/... routes. Returns true when handled. */
export async function handleSmartHttp(ctx: Ctx): Promise<boolean> {
  const match = ctx.path.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
  if (!match) return false;
  const owner = match[1]!;
  const repoName = match[2]!;
  const suffix = match[3]!;
  if (!OWNER_REPO_RE.test(owner) || !OWNER_REPO_RE.test(repoName)) return false;
  if (!requireAuth(ctx)) return true;
  try {
    if (ctx.method === 'GET' && suffix === 'info/refs') {
      return handleInfoRefs(ctx, owner, repoName);
    }
    const repo = ctx.vault.getRepo(owner, repoName);
    if (!repo) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (ctx.method === 'POST' && suffix === 'git-upload-pack') {
      const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
      if (wantsV2) handleUploadPackV2(ctx, repo);
      else handleUploadPackV0(ctx, repo);
      return true;
    }
    if (ctx.method === 'POST' && suffix === 'git-receive-pack') {
      handleReceivePack(ctx, repo);
      return true;
    }
  } catch (err) {
    // A malformed git request must never take the server down.
    if (!ctx.res.writableEnded) sendError(ctx, 400, err instanceof Error ? err.message : 'bad request');
    return true;
  }
  sendError(ctx, 404, 'Not Found');
  return true;
}

export { collectReachable };

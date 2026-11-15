// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// pull requests. All state lives in the Vault; all JSON shapes in shapes.ts.

import { b64decode, hashObject, isOid } from './util.ts';
import type { Ctx } from './httpkit.ts';
import { linkHeader, pageParams, paginate, parseJsonBody, requireAuth, sendError, sendJson } from './httpkit.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type IssueRec,
  type PullRec,
  type RepoRecord,
  type Vault,
} from './vault.ts';
import {
  branchJson,
  commentJson,
  commitSummaryJson,
  contentDirEntryJson,
  contentFileJson,
  diffTrees,
  entityId,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
} from './shapes.ts';
import { buildCommit, flattenTree, materializeTree, parseCommit, parseTree, peelToCommit } from './gitobj.ts';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function dec(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Look a repo up; 404 when missing. */
function lookupRepo(ctx: Ctx, owner: string, name: string): RepoRecord | null {
  const repo = ctx.vault.getRepo(dec(owner), dec(name));
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Resolve a branch name, ref, or sha to a commit oid (null when unresolvable). */
function resolveRefToCommit(repo: RepoRecord, ref: string): string | null {
  if (isOid(ref)) {
    const obj = repo.objects.get(ref);
    if (!obj) return null;
    return peelToCommit(repo, ref);
  }
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    return oid ? peelToCommit(repo, oid) : null;
  }
  const oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  return oid ? peelToCommit(repo, oid) : null;
}

function branchTip(repo: RepoRecord, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid ?? null;
}

function ident(epochSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

/**
 * Commit a set of file updates onto a branch: `updates` maps path -> new
 * bytes (null deletes the path). Returns the new commit oid.
 */
function commitFileUpdates(
  ctx: Ctx,
  repo: RepoRecord,
  branch: string,
  message: string,
  updates: Map<string, Buffer | null>,
): string {
  const ref = `refs/heads/${branch}`;
  let baseCommit = branchTip(repo, branch);
  if (baseCommit === null && branch !== repo.defaultBranch) {
    baseCommit = branchTip(repo, repo.defaultBranch);
  }
  const files = new Map<string, string>();
  if (baseCommit !== null) {
    const baseObj = repo.objects.get(baseCommit);
    if (baseObj && baseObj.type === 'commit') {
      const treeOid = parseCommit(baseObj.data).tree;
      for (const [path, entry] of flattenTree(repo, treeOid)) files.set(path, entry.oid);
    }
  }
  for (const [path, content] of updates) {
    if (content === null) {
      files.delete(path);
    } else {
      const oid = hashObject('blob', content);
      repo.objects.set(oid, { type: 'blob', data: content });
      files.set(path, oid);
    }
  }
  const treeOid = materializeTree(repo, files);
  const epoch = ctx.vault.clock();
  const who = ident(epoch);
  const commitData = buildCommit({
    tree: treeOid,
    parents: baseCommit === null ? [] : [baseCommit],
    author: who,
    committer: who,
    message,
    extraHeaders: [],
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(ref, commitOid);
  repo.log(`commit ${branch} ${commitOid.slice(0, 7)} ${message.split('\n')[0]}`);
  return commitOid;
}

/** Walk a commit's history, newest first (parents after the commit itself). */
function walkHistory(repo: RepoRecord, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}

// ---------------------------------------------------------------- /user + /meta + root

function handleApiRoot(ctx: Ctx): boolean {
  sendJson(
    ctx,
    200,
    { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
  return true;
}

function handleMeta(ctx: Ctx): boolean {
  sendJson(ctx, 200, { installed_version: '1.0.0' });
  return true;
}

function handleGetUser(ctx: Ctx): boolean {
  if (!requireAuth(ctx)) return true;
  sendJson(ctx, 200, {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: 'MDQ6VXNlcjEwMDA=',
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    html_url: `https://github.com/${VIEWER_LOGIN}`,
  });
  return true;
}

function handleListUserRepos(ctx: Ctx): boolean {
  if (!requireAuth(ctx)) return true;
  const repos = ctx.vault.reposOf(VIEWER_LOGIN);
  const { page, perPage } = pageParams(ctx);
  const { slice, totalPages } = paginate(repos, page, perPage);
  sendJson(ctx, 200, slice.map((repo) => repoJson(repo)), {
    link: linkHeader(ctx, page, perPage, totalPages),
  });
  return true;
}

function handleCreateUserRepo(ctx: Ctx): boolean {
  if (!requireAuth(ctx)) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : '';
  if (!NAME_RE.test(name)) {
    sendError(ctx, 422, 'Invalid repository name');
    return true;
  }
  const created = ctx.vault.createRepo(
    VIEWER_LOGIN,
    name,
    typeof record.description === 'string' ? record.description : '',
    record.private === true,
  );
  if (!created) {
    sendError(ctx, 422, 'Repository already exists');
    return true;
  }
  sendJson(ctx, 201, repoJson(created));
  return true;
}

// ---------------------------------------------------------------- repos

function handleGetRepo(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  sendJson(ctx, 200, repoJson(repo));
  return true;
}

function handlePatchRepo(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (typeof record.description === 'string') repo.description = record.description;
  if (typeof record.private === 'boolean') repo.isPrivate = record.private;
  repo.log(`repo-patch description=${JSON.stringify(repo.description)}`);
  sendJson(ctx, 200, repoJson(repo));
  return true;
}

function handleDeleteRepo(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  ctx.vault.deleteRepo(repo.owner, repo.name);
  ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
  return true;
}

function handleListBranches(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const out: Record<string, unknown>[] = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    if (ref.startsWith('refs/heads/')) out.push(branchJson(ref.slice('refs/heads/'.length), oid));
  }
  sendJson(ctx, 200, out);
  return true;
}

function handleGetBranch(ctx: Ctx, owner: string, name: string, branch: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const tip = branchTip(repo, dec(branch));
  if (tip === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  sendJson(ctx, 200, branchJson(dec(branch), tip));
  return true;
}

function handleCreateRef(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const ref = typeof record.ref === 'string' ? record.ref : '';
  const sha = typeof record.sha === 'string' ? record.sha : '';
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
    sendError(ctx, 422, 'Invalid ref');
    return true;
  }
  if (!isOid(sha) || !repo.objects.has(sha)) {
    sendError(ctx, 422, 'Invalid sha');
    return true;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx, 422, 'Reference already exists');
    return true;
  }
  repo.refs.set(ref, sha);
  repo.log(`ref-create ${ref} ${sha.slice(0, 7)}`);
  sendJson(ctx, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  return true;
}

function handleGetRef(ctx: Ctx, owner: string, name: string, refPath: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const ref = `refs/${dec(refPath)}`;
  const oid = repo.refs.get(ref);
  if (!oid) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  sendJson(ctx, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
  return true;
}

function handleListCommits(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const shaParam = ctx.query.get('sha');
  const tip = shaParam ? resolveRefToCommit(repo, shaParam) : branchTip(repo, repo.defaultBranch);
  if (tip === null) {
    sendJson(ctx, 200, []);
    return true;
  }
  const history = walkHistory(repo, tip);
  const out = history.map((oid) => {
    const obj = repo.objects.get(oid)!;
    const parts = parseCommit(obj.data);
    return commitSummaryJson(oid, parts.message);
  });
  sendJson(ctx, 200, out);
  return true;
}

function handleGetCommit(ctx: Ctx, owner: string, name: string, sha: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const commit = resolveRefToCommit(repo, dec(sha));
  if (commit === null) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const obj = repo.objects.get(commit)!;
  const parts = parseCommit(obj.data);
  sendJson(ctx, 200, commitSummaryJson(commit, parts.message));
  return true;
}

// ---------------------------------------------------------------- contents

function treeAtRef(repo: RepoRecord, ref: string | null): { commit: string; tree: string } | null {
  const commit = ref ? resolveRefToCommit(repo, ref) : branchTip(repo, repo.defaultBranch);
  if (commit === null) return null;
  const obj = repo.objects.get(commit);
  if (!obj || obj.type !== 'commit') return null;
  return { commit, tree: parseCommit(obj.data).tree };
}

function handlePutContents(ctx: Ctx, owner: string, name: string, rawPath: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const path = dec(rawPath);
  const message = typeof record.message === 'string' ? record.message : 'Update';
  const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
  if (typeof record.content !== 'string') {
    sendError(ctx, 422, 'content is required');
    return true;
  }
  const content = b64decode(record.content);
  const at = treeAtRef(repo, branch);
  const files = new Map<string, string>();
  if (at) {
    for (const [p, entry] of flattenTree(repo, at.tree)) files.set(p, entry.oid);
  }
  const existed = files.has(path);
  if (existed && typeof record.sha === 'string' && record.sha !== files.get(path)) {
    sendError(ctx, 409, 'sha does not match the current file');
    return true;
  }
  const blobOid = hashObject('blob', content);
  const commitOid = commitFileUpdates(ctx, repo, branch, message, new Map([[path, content]]));
  repo.objects.set(blobOid, { type: 'blob', data: content });
  sendJson(ctx, existed ? 200 : 201, {
    content: { sha: blobOid, encoding: 'base64', name: path.split('/').pop(), path, size: content.length },
    commit: { sha: commitOid, message },
  });
  return true;
}

function handleGetContents(ctx: Ctx, owner: string, name: string, rawPath: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const path = rawPath === '' ? '' : dec(rawPath);
  const at = treeAtRef(repo, ctx.query.get('ref'));
  if (!at) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const files = flattenTree(repo, at.tree);
  if (path === '') {
    sendJson(ctx, 200, dirListing(repo, files, '', at.tree));
    return true;
  }
  const direct = files.get(path);
  if (direct) {
    const data = repo.objects.get(direct.oid)?.data ?? Buffer.alloc(0);
    sendJson(ctx, 200, contentFileJson(repo, path, direct.oid, data));
    return true;
  }
  const prefix = `${path}/`;
  const under = [...files.keys()].some((p) => p.startsWith(prefix));
  if (!under) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  sendJson(ctx, 200, dirListing(repo, files, path, at.tree));
  return true;
}

function dirListing(
  repo: RepoRecord,
  files: Map<string, { oid: string; mode: string }>,
  dir: string,
  rootTree: string,
): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
    } else {
      const sub = rest.slice(0, slash);
      if (!seen.has(sub)) seen.set(sub, { type: 'dir', name: sub, path: `${prefix}${sub}`, sha: '' });
    }
  }
  // Directory entries need their tree sha: resolve from the stored trees.
  const out: Record<string, unknown>[] = [];
  for (const entry of [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    let sha = entry.sha;
    if (entry.type === 'dir') {
      sha = treeShaForDir(repo, entry.path, rootTree);
    }
    out.push(contentDirEntryJson(repo, entry.type, entry.name, entry.path, sha));
  }
  return out;
}

function treeShaForDir(repo: RepoRecord, dirPath: string, rootTree: string): string {
  let current = rootTree;
  for (const part of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return '';
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return '';
    current = entry.oid;
  }
  return current;
}

function handleDeleteContents(ctx: Ctx, owner: string, name: string, rawPath: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const path = dec(rawPath);
  const message = typeof record.message === 'string' ? record.message : 'Delete';
  const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
  const at = treeAtRef(repo, branch);
  if (!at) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const files = flattenTree(repo, at.tree);
  const existing = files.get(path);
  if (!existing) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (typeof record.sha === 'string' && record.sha !== existing.oid) {
    sendError(ctx, 409, 'sha does not match the current file');
    return true;
  }
  const commitOid = commitFileUpdates(ctx, repo, branch, message, new Map([[path, null]]));
  sendJson(ctx, 200, { commit: { sha: commitOid, message } });
  return true;
}

// ---------------------------------------------------------------- labels

function handleListLabels(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  sendJson(
    ctx,
    200,
    [...repo.labels.values()].map((label) => labelJson(label.name, label.color)),
  );
  return true;
}

function handleCreateLabel(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const labelName = typeof record.name === 'string' ? record.name : '';
  if (labelName === '') {
    sendError(ctx, 422, 'Label name is required');
    return true;
  }
  const color = typeof record.color === 'string' ? record.color : 'ededed';
  const existing = repo.labels.get(labelName);
  if (!existing) {
    repo.labels.set(labelName, { name: labelName, color });
    repo.log(`label-create ${labelName}`);
  }
  sendJson(ctx, 201, labelJson(labelName, repo.labels.get(labelName)!.color));
  return true;
}

// ---------------------------------------------------------------- issues

function handleCreateIssue(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title : '';
  if (title === '') {
    sendError(ctx, 422, 'Title is required');
    return true;
  }
  const labels = Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      sendError(ctx, 422, `Label does not exist: ${label}`);
      return true;
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    number,
    title,
    body: typeof record.body === 'string' ? record.body : '',
    state: 'open',
    labels,
    createdSeq: ctx.vault.nextSeq(),
  };
  repo.issues.set(number, issue);
  repo.log(`issue-create #${number} ${JSON.stringify(title)}`);
  sendJson(ctx, 201, issueJson(repo, issue));
  return true;
}

function handleListIssues(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const { page, perPage } = pageParams(ctx);
  const { slice, totalPages } = paginate(issues, page, perPage);
  sendJson(ctx, 200, slice.map((issue) => issueJson(repo, issue)), {
    link: linkHeader(ctx, page, perPage, totalPages),
  });
  return true;
}

function handleGetIssue(ctx: Ctx, owner: string, name: string, number: number): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  sendJson(ctx, 200, issueJson(repo, issue));
  return true;
}

function handlePatchIssue(ctx: Ctx, owner: string, name: string, number: number): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (typeof record.title === 'string') issue.title = record.title;
  if (typeof record.body === 'string') issue.body = record.body;
  if (record.state === 'open' || record.state === 'closed') issue.state = record.state;
  if (Array.isArray(record.labels)) {
    const labels = record.labels.filter((l): l is string => typeof l === 'string');
    for (const label of labels) {
      if (!repo.labels.has(label)) {
        sendError(ctx, 422, `Label does not exist: ${label}`);
        return true;
      }
    }
    issue.labels = labels;
  }
  repo.log(`issue-patch #${number} state=${issue.state}`);
  sendJson(ctx, 200, issueJson(repo, issue));
  return true;
}

function handleCreateComment(ctx: Ctx, owner: string, name: string, number: number): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const text = typeof record.body === 'string' ? record.body : '';
  const id = repo.nextCommentId;
  repo.nextCommentId += 1;
  repo.comments.set(id, { id, issueNumber: number, body: text, createdSeq: ctx.vault.nextSeq() });
  repo.log(`comment-create #${number} id=${id}`);
  sendJson(ctx, 201, commentJson(repo, id, number, text));
  return true;
}

function handleListComments(ctx: Ctx, owner: string, name: string, number: number): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  if (!repo.issues.has(number)) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const list = [...repo.comments.values()]
    .filter((comment) => comment.issueNumber === number)
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .map((comment) => commentJson(repo, comment.id, comment.issueNumber, comment.body));
  sendJson(ctx, 200, list);
  return true;
}

// ---------------------------------------------------------------- pulls

function pullFiles(repo: RepoRecord, pull: PullRec): Record<string, unknown>[] {
  const baseAt = treeAtRef(repo, pull.baseSha);
  const headAt = treeAtRef(repo, pull.headSha);
  const baseTree = baseAt ? baseAt.tree : null;
  const headTree = headAt ? headAt.tree : null;
  return diffTrees(repo, baseTree, headTree).map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  }));
}

/** Files changed on `tip` since `baseCommit` (used for merge-conflict detection). */
function changedSince(repo: RepoRecord, baseCommit: string, tip: string): Map<string, string | null> {
  const baseAt = treeAtRef(repo, baseCommit);
  const tipAt = treeAtRef(repo, tip);
  const baseFiles = baseAt ? flattenTree(repo, baseAt.tree) : new Map();
  const tipFiles = tipAt ? flattenTree(repo, tipAt.tree) : new Map();
  const out = new Map<string, string | null>();
  for (const [path, entry] of tipFiles) {
    if (baseFiles.get(path)?.oid !== entry.oid) out.set(path, entry.oid);
  }
  for (const path of baseFiles.keys()) {
    if (!tipFiles.has(path)) out.set(path, null);
  }
  return out;
}

function handleCreatePull(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const body = parseJsonBody(ctx);
  if (body === null && ctx.body.length > 0) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title : '';
  const headRef = typeof record.head === 'string' ? record.head : '';
  const baseRef = typeof record.base === 'string' ? record.base : repo.defaultBranch;
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (title === '' || headSha === null || baseSha === null) {
    sendError(ctx, 422, 'Invalid pull request');
    return true;
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    number,
    title,
    body: typeof record.body === 'string' ? record.body : '',
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    baseShaAtCreate: baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: ctx.vault.nextSeq(),
  };
  repo.pulls.set(number, pull);
  repo.log(`pull-create #${number} ${headRef} -> ${baseRef}`);
  sendJson(ctx, 201, pullJson(repo, pull));
  return true;
}

function handleListPulls(ctx: Ctx, owner: string, name: string): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page, perPage } = pageParams(ctx);
  const { slice, totalPages } = paginate(pulls, page, perPage);
  sendJson(ctx, 200, slice.map((pull) => pullJson(repo, pull)), {
    link: linkHeader(ctx, page, perPage, totalPages),
  });
  return true;
}

function handleGetPull(ctx: Ctx, owner: string, name: string, number: number): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  sendJson(ctx, 200, pullJson(repo, pull));
  return true;
}

function handleListPullFiles(ctx: Ctx, owner: string, name: string, number: number): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  sendJson(ctx, 200, pullFiles(repo, pull));
  return true;
}

/**
 * Merge a pull request (shared by the REST and GraphQL surfaces).
 * Returns {ok, sha, message} on success, or {ok:false, reason, status}.
 */
export function performMerge(
  repo: RepoRecord,
  pull: PullRec,
  vault: Vault,
): { ok: true; sha: string; message: string } | { ok: false; reason: string; status: number } {
  if (pull.merged || pull.state !== 'open') {
    return { ok: false, reason: 'Pull request is already merged or closed', status: 405 };
  }
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) {
    return { ok: false, reason: 'Head or base branch is missing', status: 422 };
  }
  // Conflict: the base moved since the PR opened AND both sides changed the
  // same file to different contents.
  if (baseTip !== pull.baseShaAtCreate) {
    const baseChanges = changedSince(repo, pull.baseShaAtCreate, baseTip);
    const headChanges = changedSince(repo, pull.baseShaAtCreate, headTip);
    for (const [path, headOid] of headChanges) {
      if (baseChanges.has(path) && baseChanges.get(path) !== headOid) {
        return { ok: false, reason: 'Merge conflict', status: 405 };
      }
    }
  }
  const headAt = treeAtRef(repo, headTip);
  if (!headAt) {
    return { ok: false, reason: 'Head commit is missing', status: 422 };
  }
  const epoch = vault.clock();
  const who = ident(epoch);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit({
    tree: headAt.tree,
    parents: [baseTip],
    author: who,
    committer: who,
    message,
    extraHeaders: [],
  });
  const mergeOid = hashObject('commit', commitData);
  repo.objects.set(mergeOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeOid;
  pull.baseSha = mergeOid;
  repo.log(`pull-merge #${pull.number} ${mergeOid.slice(0, 7)}`);
  return { ok: true, sha: mergeOid, message };
}

function handleMergePull(ctx: Ctx, owner: string, name: string, number: number): boolean {
  if (!requireAuth(ctx)) return true;
  const repo = lookupRepo(ctx, owner, name);
  if (!repo) return true;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const result = performMerge(repo, pull, ctx.vault);
  if (!result.ok) {
    sendError(ctx, result.status, result.reason);
    return true;
  }
  sendJson(ctx, 200, { merged: true, sha: result.sha, message: result.message });
  return true;
}

// ---------------------------------------------------------------- router

/** Handle /api/v3/... routes. Returns true when handled. */
export async function handleRest(ctx: Ctx): Promise<boolean> {
  const path = ctx.path;
  if (!path.startsWith('/api/v3')) return false;
  const rest = path.slice('/api/v3'.length);
  if (rest === '' || rest === '/') return handleApiRoot(ctx);
  if (rest === '/meta' && ctx.method === 'GET') return handleMeta(ctx);
  if (rest === '/user' && ctx.method === 'GET') return handleGetUser(ctx);
  if (rest === '/user/repos' && ctx.method === 'GET') return handleListUserRepos(ctx);
  if (rest === '/user/repos' && ctx.method === 'POST') return handleCreateUserRepo(ctx);

  const repoMatch = rest.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!repoMatch) {
    if (!requireAuth(ctx)) return true;
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  const owner = repoMatch[1]!;
  const name = repoMatch[2]!;
  const tail = repoMatch[3] ?? '';
  if (tail === '') {
    if (ctx.method === 'GET') return handleGetRepo(ctx, owner, name);
    if (ctx.method === 'PATCH') return handlePatchRepo(ctx, owner, name);
    if (ctx.method === 'DELETE') return handleDeleteRepo(ctx, owner, name);
  }
  if (tail === '/branches' && ctx.method === 'GET') return handleListBranches(ctx, owner, name);
  const branchMatch = tail.match(/^\/branches\/(.+)$/);
  if (branchMatch && ctx.method === 'GET') return handleGetBranch(ctx, owner, name, branchMatch[1]!);
  if (tail === '/git/refs' && ctx.method === 'POST') return handleCreateRef(ctx, owner, name);
  const refMatch = tail.match(/^\/git\/refs\/(.+)$/);
  if (refMatch && ctx.method === 'GET') return handleGetRef(ctx, owner, name, refMatch[1]!);
  if (tail === '/commits' && ctx.method === 'GET') return handleListCommits(ctx, owner, name);
  const commitMatch = tail.match(/^\/commits\/(.+)$/);
  if (commitMatch && ctx.method === 'GET') return handleGetCommit(ctx, owner, name, commitMatch[1]!);
  const contentsMatch = tail.match(/^\/contents(?:\/(.*))?$/);
  if (contentsMatch) {
    const rawPath = contentsMatch[1] ?? '';
    if (ctx.method === 'PUT') return handlePutContents(ctx, owner, name, rawPath);
    if (ctx.method === 'GET') return handleGetContents(ctx, owner, name, rawPath);
    if (ctx.method === 'DELETE') return handleDeleteContents(ctx, owner, name, rawPath);
  }
  if (tail === '/labels' && ctx.method === 'GET') return handleListLabels(ctx, owner, name);
  if (tail === '/labels' && ctx.method === 'POST') return handleCreateLabel(ctx, owner, name);
  if (tail === '/issues' && ctx.method === 'POST') return handleCreateIssue(ctx, owner, name);
  if (tail === '/issues' && ctx.method === 'GET') return handleListIssues(ctx, owner, name);
  const issueMatch = tail.match(/^\/issues\/(\d+)$/);
  if (issueMatch) {
    const n = Number(issueMatch[1]);
    if (ctx.method === 'GET') return handleGetIssue(ctx, owner, name, n);
    if (ctx.method === 'PATCH') return handlePatchIssue(ctx, owner, name, n);
  }
  const commentMatch = tail.match(/^\/issues\/(\d+)\/comments$/);
  if (commentMatch) {
    const n = Number(commentMatch[1]);
    if (ctx.method === 'POST') return handleCreateComment(ctx, owner, name, n);
    if (ctx.method === 'GET') return handleListComments(ctx, owner, name, n);
  }
  if (tail === '/pulls' && ctx.method === 'POST') return handleCreatePull(ctx, owner, name);
  if (tail === '/pulls' && ctx.method === 'GET') return handleListPulls(ctx, owner, name);
  const pullMatch = tail.match(/^\/pulls\/(\d+)$/);
  if (pullMatch && ctx.method === 'GET') return handleGetPull(ctx, owner, name, Number(pullMatch[1]));
  const filesMatch = tail.match(/^\/pulls\/(\d+)\/files$/);
  if (filesMatch && ctx.method === 'GET') return handleListPullFiles(ctx, owner, name, Number(filesMatch[1]));
  const mergeMatch = tail.match(/^\/pulls\/(\d+)\/merge$/);
  if (mergeMatch && ctx.method === 'PUT') return handleMergePull(ctx, owner, name, Number(mergeMatch[1]));

  if (!requireAuth(ctx)) return true;
  sendError(ctx, 404, 'Not Found');
  return true;
}

export { entityId };

// GitHub JSON shapes: the REST / GraphQL / MCP surfaces all render the same
// records, so the serializers live here once.

import { b64encode, globalId } from './util.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type IssueRec, type PullRec, type RepoRecord } from './vault.ts';
import { flattenTree } from './gitobj.ts';

/** Stable numeric id for an issue/PR/comment: repo-scoped, never reused. */
export function entityId(repo: RepoRecord, number: number): number {
  return repo.id * 1_000_000 + number;
}

export function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_pull_requests: true,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

export function commitSummaryJson(sha: string, message: string): Record<string, unknown> {
  return {
    sha,
    commit: {
      message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}

export function contentFileJson(repo: RepoRecord, path: string, sha: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    sha,
    content: b64encode(data),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
  };
}

export function contentDirEntryJson(
  repo: RepoRecord,
  type: 'file' | 'dir',
  name: string,
  path: string,
  sha: string,
): Record<string, unknown> {
  return { type, name, path, sha, size: 0, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` };
}

export function labelJson(name: string, color: string): Record<string, unknown> {
  return { name, color, description: '' };
}

export function issueJson(repo: RepoRecord, issue: IssueRec): Record<string, unknown> {
  return {
    id: entityId(repo, issue.number),
    node_id: globalId('Issue', `${repo.key}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return labelJson(name, label?.color ?? 'ededed');
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function commentJson(repo: RepoRecord, id: number, issueNumber: number, body: string): Record<string, unknown> {
  return {
    id: entityId(repo, id),
    node_id: globalId('Comment', `${repo.key}:${id}`),
    body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
  };
}

export function pullJson(repo: RepoRecord, pull: PullRec): Record<string, unknown> {
  return {
    id: entityId(repo, pull.number),
    node_id: globalId('PullRequest', `${repo.key}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: true,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- diffs

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Multiset line diff: counts lines gained/lost without a full LCS. */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** Files changed between two trees (base -> head), with line counts. */
export function diffTrees(repo: RepoRecord, baseTree: string | null, headTree: string | null): ChangedFile[] {
  const baseFiles = baseTree ? flattenTree(repo, baseTree) : new Map();
  const headFiles = headTree ? flattenTree(repo, headTree) : new Map();
  const out: ChangedFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && !head) {
      const oldData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
      const { deletions } = countLineDiff(oldData.toString('utf8'), '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!base && head) {
      const newData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
      const { additions } = countLineDiff('', newData.toString('utf8'));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base && head && base.oid !== head.oid) {
      const oldData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = countLineDiff(oldData.toString('utf8'), newData.toString('utf8'));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

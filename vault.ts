// The vault: all forge state in one place.
//
// Storage shape (deliberately a document store, not typed entity classes):
// every repository is a RepoRecord held in a Map keyed "owner/name", and every
// mutation appends one line to that repo's journal (an append-only event log).
// Git objects live in a per-repo Map<oid, {type, data}>; refs in Map<ref, oid>.
// Issues and pull requests share one number counter per repo, as on GitHub.
//
// The token owner's identity: the conformance suite addresses repositories
// under the scenario viewer's login and reads it back from GET /user, so the
// viewer login must be the scenario viewer's login. The kit fixes the seed
// (program/env/src/wire.ts: SCENARIO_SEED 0x6a09e667f3bcc909), which yields
// viewer adaiversen (id 1000) and stranger olgabauer. Those are environment
// facts from the kit, not values copied from any other entry.

import { makeClock } from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** base tip at creation, for conflict detection on merge */
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface CommentRec {
  id: number;
  issueNumber: number;
  body: string;
  createdSeq: number;
}

export interface LabelRec {
  name: string;
  color: string;
}

export class RepoRecord {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly createdAt: string;
  updatedAt: string;
  /** git object database: oid -> object */
  readonly objects = new Map<string, GitObject>();
  /** refs: full refname -> oid */
  readonly refs = new Map<string, string>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly comments = new Map<number, CommentRec>();
  readonly labels = new Map<string, LabelRec>();
  /** shared issue + PR number counter (GitHub numbers issues and PRs together) */
  nextNumber = 1;
  nextCommentId = 1;
  /** append-only event journal: one line per mutation, for auditability */
  readonly journal: string[] = [];

  constructor(owner: string, name: string, id: number, description: string, isPrivate: boolean) {
    this.owner = owner;
    this.name = name;
    this.id = id;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.journal.push(`repo-created ${owner}/${name} id=${id}`);
  }

  get key(): string {
    return `${this.owner}/${this.name}`;
  }

  log(event: string): void {
    this.journal.push(`${new Date().toISOString()} ${event}`);
    this.updatedAt = new Date().toISOString();
  }
}

/** The whole forge's state. One Vault per server process. */
export class Vault {
  readonly repos = new Map<string, RepoRecord>();
  readonly clock = makeClock();
  private nextRepoId = 1;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  hasRepo(owner: string, name: string): boolean {
    return this.repos.has(`${owner}/${name}`);
  }

  /** Create a repo; null when owner/name already exists. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new RepoRecord(owner, name, this.nextRepoId, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

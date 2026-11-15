// GitHub GraphQL v4: a small hand-rolled parser (the documents gh and
// github-mcp-server send) plus an executor over the Vault.
//
// Supports: operations with variables, aliases, inline fragments
// (`... on Repository`), __type introspection, batched arrays, and the five
// mutations the suite uses. Unknown fields answer HTTP 200 with an `errors`
// array, as GraphQL specifies.

import { decodeCursor, encodeCursor, globalId, parseGlobalId } from './util.ts';
import type { Ctx } from './httpkit.ts';
import { parseJsonBody, requireAuth, sendError, sendJson } from './httpkit.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type IssueRec,
  type PullRec,
  type RepoRecord,
} from './vault.ts';
import { diffTrees } from './shapes.ts';
import { flattenTree, parseCommit } from './gitobj.ts';
import { performMerge } from './rest.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: Value | null }[];
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@=&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} but got ${token.value}`);
    }
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          variables: [],
          selections: this.parseSelectionSet(),
        });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; defaultValue: Value | null }[] {
    const out: { name: string; defaultValue: Value | null }[] = [];
    if (this.peek()?.value !== '(') return out;
    this.next();
    while (this.peek()?.value !== ')') {
      this.expectPunct('$');
      const name = this.next().value;
      this.expectPunct(':');
      this.parseType();
      let defaultValue: Value | null = null;
      if (this.peek()?.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      out.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): void {
    if (this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    if (this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek()?.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.next().value;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): { name: string; value: Value }[] {
    const out: { name: string; value: Value }[] = [];
    if (this.peek()?.value !== '(') return out;
    this.next();
    while (this.peek()?.value !== ')') {
      const name = this.next().value;
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (this.peek()?.value !== ']') values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek()?.value !== '}') {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt',
    'author', 'labels', 'comments', 'assignees', 'milestone', 'closedAt', 'locked',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt',
    'closedAt', 'mergedAt', 'url', 'isDraft', 'reviewDecision', 'additions', 'deletions',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
    'homepageUrl', 'forkCount', 'stargazerCount', 'watchers', 'languages',
  ],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

interface ExecCtx {
  vault: import('./vault.ts').Vault;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: { message: string }[];
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg ? evalValue(arg.value, variables) : undefined;
}

function repoByGlobalId(ctx: ExecCtx, id: unknown): RepoRecord | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  const dbId = Number(parsed.payload);
  if (!Number.isSafeInteger(dbId)) return null;
  for (const repo of ctx.vault.repos.values()) {
    if (repo.id === dbId) return repo;
  }
  return null;
}

function issueByGlobalId(ctx: ExecCtx, id: unknown): { repo: RepoRecord; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [key, num] = parsed.payload.split(':');
  const repo = ctx.vault.repos.get(key ?? '');
  if (!repo) return null;
  const issue = repo.issues.get(Number(num));
  return issue ? { repo, issue } : null;
}

function pullByGlobalId(ctx: ExecCtx, id: unknown): { repo: RepoRecord; pull: PullRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [key, num] = parsed.payload.split(':');
  const repo = ctx.vault.repos.get(key ?? '');
  if (!repo) return null;
  const pull = repo.pulls.get(Number(num));
  return pull ? { repo, pull } : null;
}

function repoGlobalId(repo: RepoRecord): string {
  return globalId('Repository', String(repo.id));
}

function issueGlobalId(repo: RepoRecord, issue: IssueRec): string {
  return globalId('Issue', `${repo.key}:${issue.number}`);
}

function pullGlobalId(repo: RepoRecord, pull: PullRec): string {
  return globalId('PullRequest', `${repo.key}:${pull.number}`);
}

function issueState(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: RepoRecord, pull: PullRec): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  if (baseTip === pull.baseShaAtCreate) return 'MERGEABLE';
  const changed = (fromCommit: string, toCommit: string): Map<string, string | null> => {
    const fromObj = repo.objects.get(fromCommit);
    const toObj = repo.objects.get(toCommit);
    if (!fromObj || !toObj || fromObj.type !== 'commit' || toObj.type !== 'commit') return new Map();
    const fromFiles = flattenTree(repo, parseCommit(fromObj.data).tree);
    const toFiles = flattenTree(repo, parseCommit(toObj.data).tree);
    const out = new Map<string, string | null>();
    for (const [path, entry] of toFiles) {
      if (fromFiles.get(path)?.oid !== entry.oid) out.set(path, entry.oid);
    }
    for (const path of fromFiles.keys()) if (!toFiles.has(path)) out.set(path, null);
    return out;
  };
  const baseChanges = changed(pull.baseShaAtCreate, baseTip);
  const headChanges = changed(pull.baseShaAtCreate, headTip);
  for (const [path, headOid] of headChanges) {
    if (baseChanges.has(path) && baseChanges.get(path) !== headOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolveSelections(
  selections: SelectionNode[],
  typeName: string,
  source: unknown,
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, resolveSelections(fragment.selections, typeName, source, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, resolveSelections(selection.selections, typeName, source, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(selection, typeName, source, ctx);
  }
  return out;
}

function unknownField(field: FieldNode, typeName: string, ctx: ExecCtx): null {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return null;
}

function resolveField(field: FieldNode, typeName: string, source: unknown, ctx: ExecCtx): unknown {
  const sub = field.selections;
  const resolveSub = (nextType: string, nextSource: unknown): unknown =>
    sub ? resolveSelections(sub, nextType, nextSource, ctx) : nextSource;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return resolveSub('User', { login: VIEWER_LOGIN, id: VIEWER_ID });
      }
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', ctx.variables);
        const name = argValue(field, 'name', ctx.variables);
        const repo =
          typeof owner === 'string' && typeof name === 'string' ? ctx.vault.getRepo(owner, name) : undefined;
        if (!repo) return null;
        return resolveSub('Repository', repo);
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', ctx.variables);
        const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = repoByGlobalId(ctx, id);
          return repo ? resolveSub('Repository', repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const found = issueByGlobalId(ctx, id);
          return found ? resolveSub('Issue', { repo: found.repo, issue: found.issue }) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const found = pullByGlobalId(ctx, id);
          return found ? resolveSub('PullRequest', { repo: found.repo, pull: found.pull }) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', ctx.variables);
        if (typeof name !== 'string') return null;
        const fields = TYPE_FIELDS[name];
        const enums = ENUM_VALUES[name];
        if (fields === undefined && enums === undefined) return null;
        return resolveSub('__Type', { typeName: name, fields: fields ?? [], enums: enums ?? [] });
      }
      return unknownField(field, typeName, ctx);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(field, ctx, sub);
      if (field.name === 'closeIssue') return mutateCloseIssue(field, ctx, sub);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(field, ctx, sub);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(field, ctx, sub);
      if (field.name === 'addComment') return mutateAddComment(field, ctx, sub);
      return unknownField(field, typeName, ctx);
    }
    case 'User': {
      const user = source as { login: string; id: number };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return globalId('User', String(user.id));
      return unknownField(field, typeName, ctx);
    }
    case 'Repository': {
      const repo = source as RepoRecord;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return resolveSub('User', { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0 });
        case 'defaultBranchRef':
          return resolveSub('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'issue': {
          const number = argValue(field, 'number', ctx.variables);
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          if (!issue) return null;
          return resolveSub('Issue', { repo, issue });
        }
        case 'issues':
          return resolveSub('IssueConnection', { repo, args: field });
        case 'pullRequests':
          return resolveSub('PullRequestConnection', { repo, args: field });
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx.variables);
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          if (!pull) return null;
          return resolveSub('PullRequest', { repo, pull });
        }
        default:
          return unknownField(field, typeName, ctx);
      }
    }
    case 'Ref': {
      const ref = source as { name: string };
      if (field.name === 'name') return ref.name;
      return unknownField(field, typeName, ctx);
    }
    case 'Issue': {
      const { repo, issue } = source as { repo: RepoRecord; issue: IssueRec };
      void repo;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        default:
          return unknownField(field, typeName, ctx);
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: RepoRecord; pull: PullRec };
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'files':
          return resolveSub('PullRequestChangedFileConnection', { repo, pull, args: field });
        default:
          return unknownField(field, typeName, ctx);
      }
    }
    case 'IssueConnection': {
      const { repo, args } = source as { repo: RepoRecord; args: FieldNode };
      const first = argValue(args, 'first', ctx.variables);
      const after = argValue(args, 'after', ctx.variables);
      const states = argValue(args, 'states', ctx.variables);
      const orderBy = argValue(args, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
      let issues = [...repo.issues.values()];
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      issues.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
      const afterNumber = typeof after === 'string' ? decodeCursor(after) : null;
      if (afterNumber !== null) {
        issues = issues.filter((issue) =>
          direction === 1 ? issue.number > afterNumber : issue.number < afterNumber,
        );
      }
      const limit = typeof first === 'number' ? first : issues.length;
      const page = issues.slice(0, limit);
      const hasNextPage = issues.length > page.length;
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
      const nodes = page.map((issue) => ({ repo, issue }));
      if (field.name === 'nodes') {
        return nodes.map((node) => resolveSub('Issue', node));
      }
      if (field.name === 'pageInfo') {
        return resolveSub('PageInfo', { hasNextPage, endCursor });
      }
      return unknownField(field, typeName, ctx);
    }
    case 'PullRequestConnection': {
      const { repo, args } = source as { repo: RepoRecord; args: FieldNode };
      const first = argValue(args, 'first', ctx.variables);
      let pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
      if (typeof first === 'number') pulls = pulls.slice(0, first);
      if (field.name === 'nodes') {
        return pulls.map((pull) => resolveSub('PullRequest', { repo, pull }));
      }
      if (field.name === 'pageInfo') {
        return resolveSub('PageInfo', { hasNextPage: false, endCursor: null });
      }
      return unknownField(field, typeName, ctx);
    }
    case 'PullRequestChangedFileConnection': {
      const { repo, pull } = source as { repo: RepoRecord; pull: PullRec; args: FieldNode };
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseTree = baseTip ? treeOf(repo, baseTip) : null;
      const headTree = headTip ? treeOf(repo, headTip) : null;
      const files = diffTrees(repo, baseTree, headTree);
      if (field.name === 'nodes') {
        return files.map((file) => resolveSub('PullRequestChangedFile', { path: file.filename }));
      }
      if (field.name === 'pageInfo') {
        return resolveSub('PageInfo', { hasNextPage: false, endCursor: null });
      }
      return unknownField(field, typeName, ctx);
    }
    case 'PullRequestChangedFile': {
      const { path } = source as { path: string };
      if (field.name === 'path') return path;
      return unknownField(field, typeName, ctx);
    }
    case 'CommentEdge': {
      const edge = source as { node: { id: string; body: string } };
      if (field.name === 'node') return resolveSub('Comment', edge.node);
      return unknownField(field, typeName, ctx);
    }
    case 'Comment': {
      const comment = source as { id: string; body: string };
      if (field.name === 'id') return comment.id;
      if (field.name === 'body') return comment.body;
      return unknownField(field, typeName, ctx);
    }
    case 'PageInfo': {
      const info = source as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      return unknownField(field, typeName, ctx);
    }
    case '__Type': {
      const { typeName: name, fields, enums } = source as { typeName: string; fields: string[]; enums: string[] };
      void name;
      if (field.name === 'fields') {
        return fields.map((fieldName) => resolveSub('__Field', { name: fieldName }));
      }
      if (field.name === 'enumValues') {
        return enums.map((enumName) => resolveSub('__EnumValue', { name: enumName }));
      }
      if (field.name === 'name') return name;
      return unknownField(field, typeName, ctx);
    }
    case '__Field': {
      const { name } = source as { name: string };
      if (field.name === 'name') return name;
      return unknownField(field, typeName, ctx);
    }
    case '__EnumValue': {
      const { name } = source as { name: string };
      if (field.name === 'name') return name;
      return unknownField(field, typeName, ctx);
    }
    default:
      return unknownField(field, typeName, ctx);
  }
}

function treeOf(repo: RepoRecord, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------- mutations

function mutateCreateIssue(
  field: FieldNode,
  ctx: ExecCtx,
  sub: SelectionNode[] | null,
): unknown {
  const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const repo = repoByGlobalId(ctx, input?.repositoryId);
  if (!repo) {
    ctx.errors.push({ message: 'Repository not found for createIssue.' });
    return null;
  }
  const title = typeof input?.title === 'string' ? input.title : '';
  const body = typeof input?.body === 'string' ? input.body : '';
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = { number, title, body, state: 'open', labels: [], createdSeq: ctx.vault.nextSeq() };
  repo.issues.set(number, issue);
  repo.log(`issue-create #${number} (graphql)`);
  if (!sub) return { repo, issue };
  return resolvePayloadSelections(sub, { issue: { repo, issue } }, ctx);
}

function mutateCloseIssue(field: FieldNode, ctx: ExecCtx, sub: SelectionNode[] | null): unknown {
  const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const found = issueByGlobalId(ctx, input?.issueId);
  if (!found) {
    ctx.errors.push({ message: 'Issue not found for closeIssue.' });
    return null;
  }
  found.issue.state = 'closed';
  found.repo.log(`issue-close #${found.issue.number} (graphql)`);
  if (!sub) return { repo: found.repo, issue: found.issue };
  return resolvePayloadSelections(sub, { issue: { repo: found.repo, issue: found.issue } }, ctx);
}

function mutateCreatePullRequest(field: FieldNode, ctx: ExecCtx, sub: SelectionNode[] | null): unknown {
  const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const repo = repoByGlobalId(ctx, input?.repositoryId);
  const headRef = typeof input?.headRefName === 'string' ? input.headRefName : '';
  const baseRef = typeof input?.baseRefName === 'string' ? input.baseRefName : repo?.defaultBranch ?? 'main';
  const headSha = repo?.refs.get(`refs/heads/${headRef}`) ?? null;
  const baseSha = repo?.refs.get(`refs/heads/${baseRef}`) ?? null;
  if (!repo || headSha === null || baseSha === null) {
    ctx.errors.push({ message: 'Repository or branch not found for createPullRequest.' });
    return null;
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    number,
    title: typeof input?.title === 'string' ? input.title : '',
    body: typeof input?.body === 'string' ? input.body : '',
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
  repo.log(`pull-create #${number} (graphql)`);
  if (!sub) return { repo, pull };
  return resolvePayloadSelections(sub, { pullRequest: { repo, pull } }, ctx);
}

function mutateMergePullRequest(field: FieldNode, ctx: ExecCtx, sub: SelectionNode[] | null): unknown {
  const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const found = pullByGlobalId(ctx, input?.pullRequestId);
  if (!found) {
    ctx.errors.push({ message: 'Pull request not found for mergePullRequest.' });
    return null;
  }
  const result = performMerge(found.repo, found.pull, ctx.vault);
  if (!result.ok) {
    ctx.errors.push({ message: result.reason ?? 'Merge failed.' });
    return null;
  }
  if (!sub) return { repo: found.repo, pull: found.pull };
  return resolvePayloadSelections(sub, { pullRequest: { repo: found.repo, pull: found.pull } }, ctx);
}

function mutateAddComment(field: FieldNode, ctx: ExecCtx, sub: SelectionNode[] | null): unknown {
  const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const found = issueByGlobalId(ctx, input?.subjectId);
  if (!found) {
    ctx.errors.push({ message: 'Subject not found for addComment.' });
    return null;
  }
  const body = typeof input?.body === 'string' ? input.body : '';
  const id = found.repo.nextCommentId;
  found.repo.nextCommentId += 1;
  found.repo.comments.set(id, {
    id,
    issueNumber: found.issue.number,
    body,
    createdSeq: ctx.vault.nextSeq(),
  });
  found.repo.log(`comment-create #${found.issue.number} (graphql)`);
  const node = { id: globalId('Comment', `${found.repo.key}:${id}`), body };
  if (!sub) return { commentEdge: { node } };
  return resolvePayloadSelections(sub, { commentEdge: { node } }, ctx);
}

// Payload pseudo-types: the mutation payloads select one nested object.
function resolvePayloadSelections(
  selections: SelectionNode[],
  payload: Record<string, unknown>,
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    const nested = payload[selection.name] as { repo: RepoRecord; issue?: IssueRec; pull?: PullRec } | undefined;
    if (!nested) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on mutation payload.` });
      out[key] = null;
      continue;
    }
    if (selection.name === 'issue' && nested.issue) {
      out[key] = selection.selections
        ? resolveSelections(selection.selections, 'Issue', nested, ctx)
        : nested.issue;
    } else if (selection.name === 'pullRequest' && nested.pull) {
      out[key] = selection.selections
        ? resolveSelections(selection.selections, 'PullRequest', nested, ctx)
        : nested.pull;
    } else if (selection.name === 'commentEdge') {
      out[key] = selection.selections
        ? resolveSelections(selection.selections, 'CommentEdge', nested, ctx)
        : nested;
    } else {
      out[key] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------- entry

function executeOperation(
  operation: OperationNode,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDef>,
  vault: import('./vault.ts').Vault,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const ctx: ExecCtx = { vault, variables, fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(operation.selections, rootType, null, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** Handle POST /api/graphql. Returns true when handled. */
export async function handleGraphql(ctx: Ctx): Promise<boolean> {
  if (ctx.path !== '/api/graphql') return false;
  if (ctx.method !== 'POST') {
    sendError(ctx, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(ctx)) return true;
  const body = parseJsonBody(ctx);
  if (body === null) {
    sendError(ctx, 400, 'Invalid JSON body');
    return true;
  }
  const operations = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const operation of operations) {
    const record = (operation ?? {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    try {
      const { operations: parsed, fragments } = new Parser(tokenize(query)).parseDocument();
      const chosen =
        (operationName ? parsed.find((op) => op.name === operationName) : undefined) ?? parsed[0];
      if (!chosen) {
        results.push({ data: null, errors: [{ message: 'No operation found in document.' }] });
        continue;
      }
      results.push(executeOperation(chosen, variables, fragments, ctx.vault));
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
    }
  }
  sendJson(ctx, 200, Array.isArray(body) ? results : results[0]);
  return true;
}

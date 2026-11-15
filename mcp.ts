// Model Context Protocol over streamable HTTP: the modern `server/discover`
// era first, with the legacy `initialize` handshake as fallback. Tools are
// the six the suite requires; every tool effect is verified over REST, so the
// tools operate on the same Vault records as the REST surface.

import type { Ctx } from './httpkit.ts';
import { parseJsonBody, requireAuth, sendError, sendJson } from './httpkit.ts';
import { VIEWER_LOGIN, type RepoRecord } from './vault.ts';
import { issueJson, pullJson, repoJson } from './shapes.ts';
import { performMerge } from './rest.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const ACCEPTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'integer', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  };
}

function rpcResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(ctx: Ctx, id: unknown, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, error });
}

function toolTextResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of tool.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolErrorResult(`Unknown tool: ${name}`);
  const missing = missingArg(tool, args);
  if (missing) return toolErrorResult(`Missing required argument: ${missing}`);
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const created = ctx.vault.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (!created) return toolErrorResult(`Repository already exists: ${repoName}`);
      return toolTextResult({
        id: created.id,
        name: created.name,
        full_name: `${created.owner}/${created.name}`,
        owner: created.owner,
        private: created.isPrivate,
        description: created.description,
        default_branch: created.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = ctx.vault.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErrorResult(`Repository not found: ${args.owner}/${args.repo}`);
      return toolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = ctx.vault.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErrorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        createdSeq: ctx.vault.nextSeq(),
      };
      repo.issues.set(number, issue);
      repo.log(`issue-create #${number} (mcp)`);
      return toolTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = ctx.vault.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErrorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }));
      return toolTextResult({ issues });
    }
    case 'create_pull_request': {
      const repo = ctx.vault.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErrorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const headSha = repo.refs.get(`refs/heads/${String(args.head)}`);
      const baseSha = repo.refs.get(`refs/heads/${String(args.base)}`);
      if (!headSha || !baseSha) return toolErrorResult('Head or base branch not found');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: String(args.head),
        headSha,
        baseRef: String(args.base),
        baseSha,
        baseShaAtCreate: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: ctx.vault.nextSeq(),
      };
      repo.pulls.set(number, pull);
      repo.log(`pull-create #${number} (mcp)`);
      return toolTextResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo: RepoRecord | undefined = ctx.vault.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolErrorResult(`Repository not found: ${args.owner}/${args.repo}`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolErrorResult(`Pull request not found: ${args.pull_number}`);
      const result = performMerge(repo, pull, ctx.vault);
      if (!result.ok) return toolErrorResult(result.reason);
      return toolTextResult({ merged: true, sha: result.sha, message: result.message, number: pull.number });
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

/** Handle /mcp. Returns true when handled. */
export async function handleMcp(ctx: Ctx): Promise<boolean> {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method === 'DELETE') {
    sendJson(ctx, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
    return true;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 405, 'Method Not Allowed');
    return true;
  }
  if (!requireAuth(ctx)) return true;
  const body = parseJsonBody(ctx);
  if (body === null) {
    // Parse error: HTTP 400 with JSON-RPC -32700. Recover the id when readable.
    const raw = ctx.body.toString('utf8');
    const idMatch = raw.match(/"id"\s*:\s*(\d+|"[^"]*")/);
    let id: unknown = null;
    if (idMatch) {
      try {
        id = JSON.parse(idMatch[1]!);
      } catch {
        id = null;
      }
    }
    ctx.res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.requestId });
    ctx.res.end(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } })}\n`);
    return true;
  }
  const record = body as Record<string, unknown>;
  const id = record.id ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;
  // Notifications (no id) get no JSON-RPC response.
  if (id === null && method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  if (method === 'server/discover') {
    rpcResult(ctx, id, {
      resultType: 'server/discover',
      supportedVersions: [...ACCEPTED_REVISIONS],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge over MCP.',
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? '';
    if (requested !== '' && !ACCEPTED_REVISIONS.includes(requested)) {
      rpcError(ctx, id, -32022, 'Unsupported protocol version', { supported: [...ACCEPTED_REVISIONS] });
      return true;
    }
    const negotiated = ACCEPTED_REVISIONS.includes(requested) ? requested : PREFERRED_REVISION;
    rpcResult(ctx, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'ping') {
    rpcResult(ctx, id, {});
    return true;
  }
  if (method === 'tools/list') {
    rpcResult(ctx, id, { tools: TOOLS.map((tool) => toolJson(tool)) });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      rpcError(ctx, id, -32602, `Unknown tool: ${toolName}`);
      return true;
    }
    rpcResult(ctx, id, callTool(ctx, toolName, args));
    return true;
  }
  rpcError(ctx, id, -32601, `Method not found: ${method}`);
  return true;
}

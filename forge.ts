// The forge server: one node:http server, one Vault, and a small router.
// Routing order matters: /healthz first (no auth), then git smart HTTP,
// GraphQL, MCP, and REST v3; anything else is a JSON 404.

import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Vault } from './vault.ts';
import { readBody, sendError, sendJson, type Ctx } from './httpkit.ts';
import { handleSmartHttp } from './smart.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './gql.ts';
import { handleMcp } from './mcp.ts';

let requestCounter = 0;

function newRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}-${randomBytes(4).toString('hex')}`;
}

function pathOf(url: string | undefined): { path: string; query: URLSearchParams } {
  try {
    const parsed = new URL(url ?? '/', 'http://entry');
    return { path: parsed.pathname, query: parsed.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(vault: Vault = new Vault()): Server {
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req, res) => {
    void (async () => {
      const { path, query } = pathOf(req.url);
      const method = req.method ?? 'GET';
      let body = Buffer.alloc(0);
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        try {
          body = await readBody(req);
        } catch (err) {
          const ctx: Ctx = { vault, req, res, method, path, query, body, shopToken, requestId: newRequestId() };
          sendError(ctx, 400, err instanceof Error ? err.message : 'bad request');
          return;
        }
      }
      const ctx: Ctx = { vault, req, res, method, path, query, body, shopToken, requestId: newRequestId() };
      try {
        if (method === 'GET' && path === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (await handleSmartHttp(ctx)) return;
        if (await handleGraphql(ctx)) return;
        if (await handleMcp(ctx)) return;
        if (await handleRest(ctx)) return;
        sendError(ctx, 404, 'Not Found');
      } catch (err) {
        if (!res.writableEnded) {
          sendError(ctx, 500, err instanceof Error ? err.message : 'internal error');
        }
      }
    })();
  });
}

/** Start a server on a port (local grading helper). Returns the server. */
export async function startServer(port: number): Promise<{ server: Server; vault: Vault }> {
  const vault = new Vault();
  const server = createApp(vault);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  return { server, vault };
}

# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/slothanabot/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/slothanabot/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP (protocol
v0 + v2), REST v3, GraphQL v4, and MCP over streamable HTTP, over one
document-store vault with an append-only event journal per repository.
Standard library only — no dependencies, no git binary, no network, no model
calls. Erasable TypeScript, runs under `node --experimental-strip-types`
(Node ≥ 22.18).

Local grade: **911 / 1000** in the full env trial — feature 600/600 (120/120
checks), agent 200/200 (15/15 MCP), perf 111/200. See [GRADE.md](GRADE.md)
for the full check table, perf numbers, and reproduction commands.

## Run it

```sh
# Trial mode (the real entry point): the env owns port 8080 and tells the
# entry when the trial is done. main.ts binds an ephemeral port, registers
# it, then polls /done and exits 0.
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts

# Standalone, for local grading (any free port):
MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types -e "import('./app.ts').then(m => m.startServer(34571))"

# Grade it (from the kit directory):
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:34571 --token <token> [--perf]
```

`MAKEFUN_SHOP_TOKEN` is the Bearer token every surface checks; a missing
or wrong token is a 401 everywhere except `/healthz` and the API root.
Use a fresh server process per grade run — the suite creates repos under
fixed scenario names, so a second run against the same process fails on
422 "already exists".

## Layout

| File | What it does |
|---|---|
| `main.ts` | Env lifecycle (starter, kept as-is): bind ephemeral port, POST `{port}` to `$MAKEFUN_ENV_URL/register`, poll GET `/done`, exit 0. |
| `app.ts` | Thin adapter: re-exports `createApp` from `forge.ts`. |
| `forge.ts` | node:http server, router (`/healthz`, git smart HTTP, GraphQL, MCP, REST v3), request ids. |
| `vault.ts` | All state: a document-store `Vault` of `RepoRecord`s (objects, refs, issues, PRs, labels, comments) plus a per-repo append-only event journal. |
| `gitobj.ts` | Git objects: commit/tree/tag parse + build, packfile codec (plain objects, ofs/ref-delta resolution), reachability, fetch planning. |
| `smart.ts` | Git smart HTTP: v0/v2 advertisements, `ls-refs`, v0/v2 fetch, receive-pack with fast-forward checks and `report-status`. |
| `rest.ts` | GitHub REST v3: repos, branches, commits, contents, labels, issues, pull requests, merges (with conflict detection). |
| `gql.ts` | GraphQL v4: hand-rolled parser for the documents `gh` and `github-mcp-server` send, plus an executor and the five mutations. |
| `mcp.ts` | MCP over streamable HTTP: `server/discover`, legacy `initialize`, `tools/list`, `tools/call` for the six required tools. |
| `shapes.ts` | GitHub JSON serializers and tree diffs shared by REST, GraphQL, and MCP. |
| `httpkit.ts` | Shared HTTP plumbing: context, JSON replies, auth gate, pagination. |
| `util.ts` | SHA-1 object ids, base64, pkt-line framing, opaque Relay-style global ids. |

## Design notes

- **Fetch never re-sends held objects.** The fetch planner excludes not
  just held commits but every blob/tree reachable from a held commit (except
  past a shallow boundary), so incremental fetches send only genuinely new
  objects.
- **Shallow clones are exact.** Depth limits cut the commit walk at the
  right generation; `shallow`/`unshallow` lines track the moving boundary
  on deepen.
- **One store, three surfaces.** REST, GraphQL, and MCP all read and write
  the same vault records, so a repo, issue, or PR created over one surface
  reads back identically over the others.
- **Merge conflicts are real.** A merge is refused with 405 when the base
  moved since the PR opened and both sides changed the same file to
  different contents.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x15bjha9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

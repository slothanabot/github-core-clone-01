# GRADE — github-core-clone-01 (Slothana / keen-panda-72)

## Full env trial (program/env/server.mjs on 8080 + this entry's main.ts)

Run 2026-11-15 ~10:45–10:47 WIB. The env wrote state.json + perf.json to the
state dir; those files are the authoritative result quoted here.

| Component | Points | Max | How |
|---|---|---|---|
| Feature (conformance) | **600** | 600 | 120/120 checks passed |
| Agent (MCP) | **200** | 200 | 15/15 MCP checks passed |
| Perf | **111** | 200 | push 23, clone 26, read 35, write 27 |
| **Total** | **911** | **1000** | |

## Checks by group (env trial)

- git: 30/30
- graphql: 20/20
- issues: 15/15
- mcp: 15/15
- protocol: 5/5
- pulls: 20/20
- repos: 15/15

## Perf (env trial, perf.json)

| Workload | Ops | p50 ms | p99 ms | T_ref ms | Points |
|---|---|---|---|---|---|
| push | 200 | 590.180 | 655.840 | 514.838 | 23 |
| clone | 50 | 112.541 | 207.624 | 121.436 | 26 |
| read | 2000 | 528.863 | 726.216 | 899.962 | 35 |
| write | 200 | 108.084 | 134.154 | 120.093 | 27 |

perf_p50_us: 248228; points_total: 111.

## Standalone confirmation (sdk/run.ts, fresh server, --perf)

Run 2026-11-15 ~10:44 WIB: **120/120 checks, feature 600, agent 200,
perf 110, total 910/1000** (push 24, clone 27, read 31, write 28;
perf_p50_us 246677). Perf points vary run to run on this shared sandbox;
the env-trial numbers above are the authoritative ones.

## Reproduce

```sh
# Full env trial:
rm -rf /tmp/env-state; mkdir -p /tmp/env-state
MAKEFUN_STATE_DIR=/tmp/env-state MAKEFUN_ENV_PORT=8080 MAKEFUN_SHOP_TOKEN=<token> \
  node <kit>/program/env/server.mjs &
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts
# then read /tmp/env-state/export/state.json and perf.json

# Standalone (fresh server per run):
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types -e \
  "import('./app.ts').then(m => m.startServer(34571))"
node --experimental-strip-types <kit>/sdk/run.ts \
  --url http://127.0.0.1:34571 --token <token> [--perf]
```

No checks fail. Nothing is inflated: the numbers above are copied from the
runner/env output files.

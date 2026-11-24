# sql-anything: repository conventions

For contributors and coding agents. Human-oriented detail is in [CONTRIBUTING.md](CONTRIBUTING.md).

sql-anything finds slow SQL in a running Node app (N+1 loops, missing indexes, selective scans), fixes it with a deterministic
index generator or an agent, and refuses any fix it cannot replay-verify on database clones. TypeScript, Node 22.13+, ESM.

## Commands

```bash
npm ci
npm run build                    # tsc -> dist/ (src/ -> dist/src, test/ -> dist/test)
npm run test:unit                # about 1 s: pure logic and the documentation drift guard
npm run test:sqlite              # build + unit + SQLite integration (hook, scan, verify, trap suite, fix loop, MCP)
npm run test:integration:pg      # Postgres integration (trap suite on Postgres, scan, Prisma 7, examples)
npm test                         # everything: about 10 to 12 minutes
npm run check:pack               # fails if the npm tarball would contain anything it should not
node dist/src/cli.js --help      # the CLI from a checkout
```

Postgres tests start an embedded Postgres, or use `SA_TEST_PG_URL=postgres://USER:PASSWORD@HOST:5432/postgres` (CI does).
Integration tests run serially on purpose: they measure timings.

## Architecture map

| Path | Role |
|---|---|
| `src/cli.ts` | argument parsing and the `HANDLERS` map (typed against `COMMANDS`); prints results, returns exit codes |
| `src/meta.ts` | `COMMANDS` and `EXIT`: the public surface the docs describe |
| `src/api.ts`, `src/go.ts`, `src/demo.ts` | `runScan`, `runVerify`; the `go` pipeline; the synthetic showcase |
| `src/hook/` | capture hook loaded with `NODE_OPTIONS=--import`: wraps `pg`, `better-sqlite3`, `node:sqlite`; request grouping; kill switch |
| `src/trace/` | trace record types, typed parameter serialization (Date, BigInt, Buffer), trace reader |
| `src/sql/` | normalizer and fingerprints, statement classification (noise, volatile functions, ORDER BY/LIMIT) |
| `src/scan/` | findings (N+1, selective seq scans, correlated subqueries), `EXPLAIN` on a clone |
| `src/db/` | `Conn` implementations (SQLite, Postgres) and shadow-database cloning |
| `src/verify/` | **the gate**: parity, interleaved A/B with bootstrap CI, A/A noise floor, regression and write guards; `check.ts` is the end-to-end N+1 check |
| `src/fix/`, `src/agent.ts` | index candidates, the agent loop in a git worktree, agent process handling |
| `src/report/` | Markdown PR block and SVG card |
| `src/mcp.ts` | stdio MCP server |
| `skills/sql-anything/SKILL.md` | the agent skill |
| `examples/` | synthetic apps (`sqlite-shop`, `postgres-saas`); the demo ships a copy of `sqlite-shop` |
| `docs/assets/`, `docs/benchmarks/` | README images; benchmark results (every number in the README comes from here) |
| `test/integration/traps.ts` | the trap suite: wrong patches that `verify` must reject, run on SQLite and Postgres |

## Hard rule: documentation changes with the code

Any commit or PR that **adds, removes or changes a CLI subcommand, a flag, an exit code, an MCP tool, a supported driver or stack,
a gate threshold, or a benchmark result** MUST update all three of these in the **same commit**:

1. `README.md`
2. `skills/sql-anything/SKILL.md`
3. `CHANGELOG.md`

`test/unit/readme-sync.test.ts` (part of `npm test` and CI) enforces the checkable part: commands in `src/meta.ts` against the README
table and `--help`; every flag the parser accepts against the README (and no invented flags in the README, `--help` or `SKILL.md`);
registered MCP tools against the README and `SKILL.md`; exit codes in `EXIT` against the README, `--help` and `SKILL.md`; README images
(raw GitHub URLs into `docs/assets/`) and relative links exist; every speedup and `N/N` count in the README appears in a file under
`docs/benchmarks/` or `docs/assets/`.

Do not edit that test to make it pass. A new command goes in `COMMANDS` and in `HANDLERS` (it does not compile otherwise); a new
exit code goes in `EXIT`. Never invent, round up or estimate a number in the docs: record the artifact first, then quote it, and say
what was not tested.

## Other conventions

- Nothing is reported as a win unless it was replay-verified. Never weaken a gate threshold or comparison to get a test green. A change under
  `src/verify/` comes with a new or extended trap in `test/integration/traps.ts`.
- Reports, cards and MCP results carry normalized SQL only: no parameter values, no absolute paths.
- No new runtime dependencies without discussion (currently `pg`, `@modelcontextprotocol/sdk`, `zod`).
- Keep planning notes, traces, `.env` files, database files and `spikes/` out of the repository. `npm run check:pack` guards the tarball.
- Pushing, tagging and publishing are the maintainers' job: do not do them unless asked.

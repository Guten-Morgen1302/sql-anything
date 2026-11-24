# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project aims to follow [Semantic Versioning](https://semver.org/) once 1.0 is released.

## [0.1.0] - Unreleased

First release.

### Added

- **Capture hook** (`NODE_OPTIONS=--import`, no code changes) for `pg`, `better-sqlite3` and `node:sqlite`. Covers Drizzle, Knex,
  Kysely, Sequelize and Prisma 7 (driver adapter over `pg`). Records statements, typed parameters (Date, BigInt, Buffer), timing,
  the HTTP request each query belongs to, and the exact `file:line` that issued it. Follows into worker threads and child processes.
  `SQL_ANYTHING_DISABLE=1` is a kill switch.
- **`scan`**: ranks N+1 loops (with call site and lookups per request), selective sequential scans, correlated subqueries and slow
  statements. `EXPLAIN` runs on a clone: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on Postgres, `EXPLAIN QUERY PLAN` on SQLite.
  Transaction control, health checks and ORM schema introspection are ignored.
- **`verify` / `bench`**: replay-verifies a migration or SQL rewrite on database clones. Row-for-row parity on up to 500 captured
  inputs (order-sensitive under `ORDER BY`), randomized interleaved A/B timing with a bootstrap confidence interval and an A/A noise
  floor, a regression guard, and a write-regression guard. Volatile functions, `LIMIT` without `ORDER BY`, unserializable parameters
  and schema introspection are reported as unverifiable (exit code 4), never as a win.
- **N+1 verification end to end**: `--check-url` / `--check-cmd` run the app before and after a code change on identical clones,
  compare canonicalized JSON/stdout (noisy fields auto-masked), wall time and queries per request.
- **`fix`**: deterministic `CREATE INDEX` candidates (no LLM), then an agent loop (`--agent claude` or `--agent-cmd`) in a git
  worktree, every candidate gated by verification, rejection reasons fed back to the agent, a verified change saved as `fix.patch`
  (`git apply -R` rolls it back). `--migration` puts a hand-written index through the same gate.
- **`go`**: capture, scan, fix and report in one command, with a printed plan and `--dry-run`.
- **`report`**: a Markdown PR block and a dark-mode SVG benchmark card (p50/p95 before and after, speedup, plan shift, queries per
  request, `N/N replayed · row parity`). No parameter values and no absolute paths.
- **`demo`**: a zero-config, zero-Docker showcase on a synthetic SQLite shop (about 15 seconds).
- **`mcp`**: stdio MCP server with `scan`, `verify`, `verify_workload`, `fix` and `report`. Agent skill in `skills/sql-anything/SKILL.md`.
- **Examples** (synthetic, labeled): `examples/sqlite-shop` and `examples/postgres-saas`.
- Test suite of 134 tests, including a **trap suite** that proves the gate rejects wrong patches on SQLite and real Postgres.

### Known limitations

- Node.js only; Prisma 6 and earlier (native engine), bundled or serverless apps that drop `NODE_OPTIONS`, and other languages are not captured.
- Postgres and SQLite only.
- Verification is evidence, not proof: captured inputs, one data snapshot, a cloned database.
- Tested on Windows with Node 24. CI (Ubuntu, Node 22 and 24, Postgres 16) is configured but had not run at the time of writing.
  macOS, Postgres below 15 and remote databases are untested.
- `examples/postgres-saas/docker-compose.yml` has not been run; the example is tested against an embedded Postgres.
- On the one real application tried (a RealWorld reference app on Sequelize), no fix passed the gate; see `docs/benchmarks/conduit/RESULTS.md`.

[0.1.0]: https://github.com/Guten-Morgen1302/sql-anything/releases/tag/v0.1.0

<div align="center">

# sql-anything

**Don't rewrite your backend in Rust. Fix the 5% of SQL queries killing it.**

[![CI](https://github.com/Guten-Morgen1302/sql-anything/actions/workflows/ci.yml/badge.svg)](https://github.com/Guten-Morgen1302/sql-anything/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sql-anything)](https://www.npmjs.com/package/sql-anything)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-339933)](package.json)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

![Verified index fix: p50 5.6 ms to 0.41 ms, 13.9x](docs/benchmarks/sqlite-shop/card-index.svg)

*`examples/sqlite-shop`, synthetic data (30,000 orders). `sql-anything` picked `CREATE INDEX` on `orders(customer_id)` for an
unindexed lookup and verified it: p50 5.6 ms to 0.41 ms, 13.9x, **123/123 replayed · row parity**.
[Every number behind this card.](docs/benchmarks/sqlite-shop/RESULTS.md) For a real application, where the gate refused every
patch, see [Verified results](#verified-results).*

Most slow backends are slow because of their SQL: N+1 loops, missing indexes, scans that discard 99% of the rows they read.
`sql-anything` finds those statements in your running Node app with the `file:line` that issued them, fixes them with a
deterministic index generator or a coding agent, and **refuses any fix it cannot replay-verify**.

## 15-second quickstart

```bash
# zero Docker, no API key, no network: a synthetic SQLite shop, about 15 seconds
npx sql-anything demo

# your app (SQLite file or Postgres URL; --hit requests URLs so the hook sees real traffic)
npx sql-anything go --db <sqlite-file | postgres://...> --agent claude \
  --hit http://127.0.0.1:3000/slow-page -- node server.js
```

```
capture (--import hook) -> scan (EXPLAIN + N+1 attribution) -> fix (deterministic index | agent in a git worktree)
                        -> verify (shadow DB + parity + A/B CI) -> report (fix.patch + SVG)
```

`go` prints its plan first (`--dry-run` stops there). It does not modify your repository or database: verified changes are
written as files under `.sql-anything/` (`migration.sql`, `down.sql`, `fix.patch`).

## Verified results

### A real application: conduit (no verified speedup yet)

[TonyMckes/conduit-realworld-example-app](https://github.com/TonyMckes/conduit-realworld-example-app) (Express 5, Sequelize,
Postgres), seeded with about 636k synthetic rows, run locally. **The gate refused every patch it was given.** Full log and
reproduction steps: [docs/benchmarks/conduit/RESULTS.md](docs/benchmarks/conduit/RESULTS.md).

| Finding | What was tried | Outcome | Measured |
|---|---|---|---|
| Article listing, 5 calls, 1,312 ms total | generated indexes `Tags(name)`, `Articles(id, userId)` | rejected: speed | 0.99x and 1.10x (CI lower bound 0.90x, 0.96x; needs 1.5x) |
| An article-listing variant flagged as a correlated subquery, 842 ms | generated `Articles(id, userId, createdAt)` | rejected: speed | 0.98x (CI lower bound 0.95x) |
| The three listing findings | hand-written indexes on `Articles(createdAt)`, `TagList(tagName)`, `Articles(userId)` | rejected: parity | 498 of 500 inputs identical; same rows, different order |
| The N+1 / listing code | real `claude` CLI, 2 attempts | rejected: parity | `$.articles[12].tagList[0]`: `"tag8"` before, `"tag25"` after |

The scan itself worked: 2,176 statements captured, N+1 loops of 50 lookups per request attributed to their lines in
`controllers/articles.js` and `helper/helpers.js`. The parity rejections are the gate doing its job: the SQL never pins the order of an article's tags, so a new
plan reorders them. Whether that matters is your call; `verify` will not make it for you.

### Reproducible synthetic examples

Synthetic data, staged slowness. They show the loop, not a benchmark of your app.

| Example | One command | What you get |
|---|---|---|
| [`examples/sqlite-shop`](examples/sqlite-shop) (zero Docker) | `npx sql-anything demo` | A live run with the real `claude` CLI: index **13.93x** (123/123 replayed · row parity); the N+1 rewritten by `claude` **17.95x**, 41 to 2 statements per request (15/15 runs · output parity). [Numbers](docs/benchmarks/sqlite-shop/RESULTS.md) |
| [`examples/postgres-saas`](examples/postgres-saas) (Docker Compose, 100k+ rows) | `cd examples/postgres-saas && npm install && npm run setup` | An N+1 driver loop, an unindexed three-table join and a correlated subquery. The test suite seeds it at 1/10 scale into Postgres and asserts all three are found and the N+1's count query gets a verified composite index (3.3x when I recorded it). The compose file itself has not been run |

## Proof, not vibes: how the gate works

- **Shadow clones.** Every check runs on copies of your database. SQLite: `VACUUM INTO` a temp file. Postgres: `CREATE DATABASE ... TEMPLATE ... STRATEGY = FILE_COPY`
  on 15+, plain `TEMPLATE` below 15. If other sessions hold the source open it falls back to temporary schemas **inside** the source
  database, with a warning (see [SECURITY.md](SECURITY.md)). A non-local Postgres host is refused unless you pass `--allow-remote-shadow`.
- **Canonical replay.** Up to 500 captured parameterized queries are replayed before and after. Columns, rows, duplicates and NULLs
  must match exactly, and so must the order when the query has an `ORDER BY`. `N/N replayed · row parity` means that. It is
  **evidence, not proof**: captured inputs, one data snapshot, a copy of your database.
- **Volatile queries are excluded, not guessed.** `now()`, `random()`, sequences, `LIMIT` without `ORDER BY`, unserializable
  parameters and schema introspection are marked unverifiable. If nothing verifiable is left, `verify` exits `4`. It never reports a pass for them.
- **Timing.** Three clones: baseline, patched, and a second untouched baseline (the A/A noise floor). Runs are interleaved in
  random order. The gate is the lower bound of a bootstrap 95% confidence interval of the speedup (default 1.5x, `--min-speedup`), not a median.
  Nothing else may get more than 10% slower beyond the noise floor (`--max-regress`).
- **Write guard.** Captured `INSERT`/`UPDATE`/`DELETE` are replayed in rolled-back transactions on both clones. A patch is rejected if
  write time rises more than 15% (CI lower bound, `--write-budget`) or a captured write behaves differently, for example a new
  UNIQUE index. It only runs when writes were captured, and it is an estimate.
- **Your working tree is not touched.** Agents edit a git worktree. A code fix is saved as `fix.patch` (`git apply -R` reverts it), an
  index as `migration.sql` plus `down.sql`; you apply them. `SQL_ANYTHING_DISABLE=1` makes the capture hook do nothing and makes `go` and `fix` refuse to run.

N+1 fixes are verified end to end: the app runs before and after on identical clones (`--check-url` with `{port}`, or
`--check-cmd`), canonicalized JSON or stdout must match (fields that differ between two baseline runs are masked), and wall time must clear the same bound.

## Use with coding agents

**Claude Code.**

```bash
claude mcp add sql-anything -- npx -y sql-anything mcp
```

That works once `sql-anything` is published to npm. From a checkout:
`claude mcp add sql-anything -- node /path/to/sql-anything/dist/src/cli.js mcp`.

| MCP tool | Does |
|---|---|
| `scan` | capture (or read a trace) and return ranked findings, normalized SQL only |
| `verify` | replay-verify a migration or SQL rewrites on clones; verdict `PASS`, `REJECT` or `UNVERIFIABLE` |
| `verify_workload` | verify an application-code change end to end (`checkUrl` or `checkCmd`) |
| `fix` | deterministic index candidates through the gate; writes `migration.sql` and `down.sql` |
| `report` | write the Markdown PR block and SVG cards |

**The skill.** [`skills/sql-anything/SKILL.md`](skills/sql-anything/SKILL.md) tells an agent when to use the tool and the rule it must
not break: do not say "verified" unless `verify` returned `PASS`. For Claude Code, copy the folder to `~/.claude/skills/sql-anything/`
(or `.claude/skills/` in a repository). For Codex CLI and Cursor I have not tested an install path: the file is plain Markdown, so
reference it from `AGENTS.md` or a Cursor rule, and register the MCP server with command `npx` and args `-y sql-anything mcp`.

`--agent claude` is the only built-in agent. `--agent-cmd "<command>"` runs any headless agent that reads its prompt on stdin.

## CLI reference

| Command | What it does | Key flags |
|---|---|---|
| `go` | capture, scan, fix, verify, report in one run | `--db`, `--agent`, `--hit`, `--duration`, `--max-fixes`, `--dry-run`, `--label` |
| `scan` | capture and rank findings; `EXPLAIN` runs on a clone | `--db`, `--hit`, `--duration`, `--trace`, `--no-explain` |
| `fix <F1>` | find a verified fix for one finding | `--db`, `--agent`, `--agent-cmd`, `--no-index`, `--migration`, `--max-attempts`, `--max-seconds`, `--run`, `--check-url`, `--check-cmd` |
| `verify` | replay-verify a migration, a SQL rewrite, or a code change | `--db`, `--migration`, `--rewrite`, `--target`, `--baseline-dir`, `--patched-dir`, `--check-url`, `--check-cmd` |
| `bench` | the timing half of `verify`, no pass/fail | same flags as `verify` |
| `report` | Markdown PR block and dark-mode SVG card | `--trace`, `--fix`, `--out`, `--label` |
| `mcp` | stdio MCP server | none |
| `demo` | the synthetic SQLite showcase | `--out`, `--no-open`, `--keep` |

Other options: `--json` (machine-readable output), `--seed`, `--samples`, `--rounds`, `--reps`, `--min-speedup`, `--max-regress`,
`--write-budget`, `--hit-repeat`, `--n-plus-one-min`, `--explain-top`, `--agent-timeout`, `--project`, `--allow-remote-shadow`.
`sql-anything --help` is the source of truth.

| Exit code | Meaning |
|---|---|
| `0` | ran; verified win, or nothing to fix |
| `2` | a patch was rejected by the gate |
| `3` | usage or environment error |
| `4` | nothing captured, or the result is unverifiable |

`4` after a scan means the hook did not load or no SQL ran. It does not mean your app is fine.

## Supported stacks and limitations

Node.js 22.13 or newer. The capture hook wraps `pg`, `better-sqlite3` and `node:sqlite`.

| Stack | Evidence |
|---|---|
| `pg` (`Pool` and `Client`, callback and promise forms) | automated tests, SQLite and real Postgres |
| `better-sqlite3`, `node:sqlite` | automated tests |
| Prisma 7 via `@prisma/adapter-pg` | automated test through the production hook |
| Sequelize on Express 5 | run once against a real app (conduit) |
| Drizzle (`pg`, `better-sqlite3`), Knex (`pg`), Express, Fastify | exercised in a spike; not in the automated suite |

**Not covered in v0.1:** Prisma 6 and earlier (native query engine), `mysql2`, `postgres.js`, MySQL, Python, Go, generic
stateful HTTP record/replay (the N+1 check is a read-only `GET` or a one-shot command), and apps that bundle their dependencies or
drop `NODE_OPTIONS` (bundled Next.js and edge runtimes). Tested on Windows with Node 24; the Ubuntu CI workflow exists and had not run when this was written.
Details and how to add a driver: [CONTRIBUTING.md](CONTRIBUTING.md). Threat model and reporting: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Privacy and safety

- Everything runs on your machine. No telemetry, no update check; the only network requests it makes are `GET`s to the URLs you pass with `--hit` and `--check-url`.
- Reports and SVG cards contain normalized SQL and project-relative paths: no raw parameter values, no absolute file paths. (The traces in `.sql-anything/` do hold real parameters; they git-ignore themselves and should not be shared.)
- No LLM is called unless you pass `--agent` or `--agent-cmd`. Agents run in a worktree with database connection variables removed from their environment.

MIT licensed. Synthetic examples are labeled as synthetic on their cards.

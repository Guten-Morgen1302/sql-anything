---
name: sql-anything
description: Find the slow SQL in a Node app (N+1 loops, missing indexes, seq scans, correlated subqueries), fix it, and replay-verify the fix before claiming a win. Use when the user says a page, endpoint or job is slow, asks to find N+1 queries, add an index, speed up a query, or review a query change for correctness and speed. Works with pg, better-sqlite3 and node:sqlite (so Drizzle, Knex, Kysely, Prisma 7 via adapter-pg).
---

# sql-anything

Slow apps are usually slow SQL, not slow code. This skill finds the worst statements with their exact `file:line`, and it never lets you claim a fix that was not replay-verified.

## The loop

1. **Scan.** Run the app under the capture hook and exercise the slow path.
   `sql-anything scan --db <sqlite-file|postgres-url> --hit http://127.0.0.1:3000/slow-page -- node server.js`
   Output is a ranked list: `F1 n+1 ... at src/orders.js:42`. Findings carry normalized SQL only, never parameter values.
2. **Pick the top finding.** One fix per fingerprint. An N+1 and its sequential scan are usually the same statement: index first, then the loop.
3. **Fix it.**
   - Missing index: `sql-anything fix F1 --db <db>`. It tries deterministic `CREATE INDEX` candidates and returns the first one that passes the gate, plus `migration.sql` and `down.sql`. No LLM involved.
   - N+1 or a bad query: edit the code yourself (see "Fixing N+1" below), then verify.
4. **Verify.** Nothing is a fix until `verify` says `PASS`.
   - SQL change: `sql-anything verify --db <db> --migration idx.sql` or `--rewrite rewrites.json` (`{"<fingerprint>": "<new sql>"}`, same placeholders in the same order).
   - Code change: `sql-anything verify --db <db> --baseline-dir <before> --patched-dir <after> --check-cmd "node server.js cmd"` (or `--check-url http://127.0.0.1:{port}/page --run "node server.js"`). Use two git worktrees for before and after.
5. **Report.** `sql-anything report` writes `report.md` (a PR-ready block) and a dark-mode SVG card per verified fix.

`sql-anything go --db <db> --agent claude --hit <url> -- <app command>` runs all of that in one command.

## Verify-before-claiming (non-negotiable)

- Say "verified" only after `verify` or `fix` returned `PASS` (exit code 0). Quote the measured numbers from its output, not estimates.
- `REJECT` (exit 2) means the patch is wrong or slower. Read the failed gate and the `mismatches`, fix the cause, run again. Do not edit the gate, lower `--min-speedup`, or change the replay inputs to get a pass.
- `UNVERIFIABLE` (exit 4) means it cannot be checked row for row: volatile functions (`now()`, `random()`), `LIMIT` without `ORDER BY`, unserializable params, too few samples, or nothing captured. Say so plainly. Do not report it as a win.
- The gate is evidence, not proof: captured inputs, one data snapshot, a cloned database. Say that when you summarize.
- Budget: at most 3 attempts per finding. After that, stop and report what is still red and why.

## Fixing N+1

- Replace the per-row lookup with eager loading or one batched query (`WHERE id IN (...)`, a join with a `GROUP BY`, or the ORM's include/with). Output must stay byte-for-byte identical.
- Traps the gate catches: `LEFT JOIN` turned into `INNER JOIN` (drops rows with no children), `NOT IN` turned into `NOT EXISTS` (differs when the subquery has a NULL), a join that multiplies rows, `ORDER BY` ties broken differently, and an index that speeds reads but slows writes by more than 15%.
- Keep the change to the smallest diff. Do not touch tests, lockfiles or CI.

## Safety rules

- Never connect to the user's database to "try" a fix. All checking happens on clones that sql-anything makes and deletes. The source database is only read.
- `EXPLAIN ANALYZE` runs on a clone, never on the live database.
- Never run a migration against a real database yourself. `fix` writes `migration.sql` and `down.sql`; the user applies them.
- Traces under `.sql-anything/` contain real query parameters. They are git-ignored automatically. Do not paste them into chat, commits or issues.
- Kill switch: `SQL_ANYTHING_DISABLE=1` makes the capture hook do nothing and makes `go` and `fix` refuse to run.
- Reverting an agent code fix is `git apply -R .sql-anything/runs/<run>/fixes/F1/fix.patch`; reverting an index is running `down.sql`.

## Exit codes

| code | meaning |
|---|---|
| 0 | ran; verified win, or nothing to fix |
| 2 | patch rejected by the gate |
| 3 | usage or environment error |
| 4 | nothing captured, or the result is unverifiable |

## When capture shows nothing (exit 4)

"0 queries captured" does not mean the app is fine. The hook did not load or no SQL ran. Check: the app runs through a bundler or a wrapper that drops `NODE_OPTIONS`; the driver is not `pg`, `better-sqlite3` or `node:sqlite` (Prisma 6 and earlier use a native engine and are not captured); the request never reached the slow path.

## MCP

`claude mcp add sql-anything -- npx sql-anything mcp` exposes `scan`, `verify`, `verify_workload`, `fix` and `report` with the same semantics and exit meanings as above. Over MCP, `fix` is the deterministic index path only: make code changes yourself and call `verify_workload`.

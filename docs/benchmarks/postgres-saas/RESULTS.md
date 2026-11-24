# examples/postgres-saas

**Synthetic data, staged slowness.** Two records: a run on real Docker Compose at full scale (below), and what the automated test does
at 1/10 scale against an embedded Postgres. Neither is a benchmark of a real application.

## Run on Docker Compose, full scale

The one-command setup, the server and `sql-anything go` against the real `docker-compose.yml`.

| | |
|---|---|
| Machine | Windows 11, Node 24.10, Docker 29.3.1 (Linux engine), `postgres:17` |
| Setup | `npm install && npm run setup`: random password into `.env`, `docker compose up -d --wait`, seed. 38 s wall time (whether the image was already pulled was not recorded); the seed itself took 2.2 s |
| Data | 324,020 rows: 20 tenants, 2,000 users, 2,000 projects, 120,000 tasks, 200,000 comments |
| Endpoints, one request each, before sql-anything | `/projects` (N+1) 1,632 ms; `/overdue` (unindexed join) 142 ms; `/dashboard` (correlated subquery) 2,109 ms |
| Command | `sql-anything go --db "$(node db.mjs)" --agent none --max-fixes 3 --max-seconds 150 --hit <projects> --hit <overdue> --hit <dashboard> --hit-repeat 2 -- node server.mjs` |
| Agent | none: deterministic index candidates only |
| Captured | 292 statements from 1 process |

### Findings (ranked)

| | Kind | Calls | Total | Where |
|---|---|---:|---:|---|
| F1 | seq-scan | 285 | 3,825 ms | `server.mjs:17` (`count(*)` on `tasks` by `project_id` and `status`) |
| F2 | n+1 | 285 | 3,825 ms | same statement and line: 95 lookups per request, 3 requests |
| F3 | correlated-subquery | 2 | 4,708 ms | `server.mjs:41` (the dashboard comment count) |
| F4 | seq-scan | 2 | 22.6 ms | `server.mjs:26` (the three-table join) |
| F5 | seq-scan | 3 | 18.2 ms | `server.mjs:13` |

F1 and F2 are one statement seen two ways: a sequential scan per lookup, repeated 95 times per request.

### Verified fixes

`CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_project_id_status" ON "tasks" ("project_id", "status");` (generated, no LLM), 1 attempt each.

| | F1 | F2 |
|---|---:|---:|
| Speedup | **6.30x** (95% CI lower bound 6.08x, n = 285) | **5.48x** (lower bound 5.25x, n = 285) |
| p50 | 15.696 ms to 2.493 ms | 10.072 ms to 1.837 ms |
| p95 | 30.855 ms to 4.384 ms | 27.66 ms to 3.059 ms |
| Parity | **98/98 replayed** · row parity | **98/98 replayed** · row parity |
| Plan | `Aggregate > Seq Scan on tasks` to `Aggregate > Index Only Scan on tasks` | same |
| Gates | parity, speed, regression pass; write guard skipped (no writes captured) | same |

The shadow clones were made with `CREATE DATABASE ... TEMPLATE` (the recorded method is `template`; the code adds `STRATEGY = FILE_COPY` on Postgres 15 and newer), not the schema-clone fallback, and no warnings were reported.

The index makes each of the 95 lookups cheaper. **The loop itself (95 statements per request) is still there**: removing it needs a code
change (`--agent claude`), which was not run on this example. These are query-level numbers, not whole-endpoint wall time.

### Not verified

- **F3, the dashboard correlated subquery: UNVERIFIABLE.** The generated candidate (`tasks(id, project_id)`) could not be judged: only 20 timing samples
  were collected within the 150 s budget, 30 are needed, because each run of that query takes about 2 s. It is not a win and no number is claimed. A real fix is a
  rewrite (a join with a grouped count), which needs an agent; not run here.
- **F4 and F5** were not attempted (`--max-fixes 3`).

### The run left no trace

After the run the source database had no `idx_tasks%` index and there were 0 leftover `sa_shadow_%` databases. `npm run teardown` removed the
container and network; the generated `.env` is git-ignored.

## The automated test (embedded Postgres, 1/10 scale)

`test/integration/example.postgres-saas.pg.test.ts` runs in CI on every push.

| | |
|---|---|
| Data | `seed(url, 0.1)`: about 12,000 tasks and 20,000 comments |
| Traffic | `GET /api/tenants/1/{projects,overdue,dashboard}`, 2 rounds, plus the readiness probe |
| Reproduce | `npm run test:integration:pg` (or the single file) |

It asserts that scan reports the N+1 (at least 90 lookups per request, attributed to `server.mjs:<line>`), the correlated subquery and the
unindexed three-table join, and that the N+1's count query gets a verified composite index (verdict `PASS`, index scan in the plan after the change). The
speedup in the run recorded at this scale was **3.3x**; the test asserts that the gate passes (a lower bound of at least 1.5x), not that number.

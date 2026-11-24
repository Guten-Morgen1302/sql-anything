# examples/postgres-saas: what the test suite recorded

**Synthetic data, staged slowness, reduced scale.** This is not a Docker Compose run (the compose file has not been run). It is
what `test/integration/example.postgres-saas.pg.test.ts` does against an embedded Postgres.

| | |
|---|---|
| Data | `seed(url, 0.1)`: 1/10 of the default 100k+ rows (about 12,000 tasks, 20,000 comments) |
| Traffic | `GET /api/tenants/1/{projects,overdue,dashboard}`, 2 rounds, plus the readiness probe |
| Reproduce | `npm run test:integration:pg` (or the single file) |

## Findings the test asserts

- an **N+1** in a driver loop: one `count(*)` on `tasks` per project, attributed to `server.mjs:<line>`, at least 90 lookups per request
- a **correlated subquery**: the per-project comment count
- an **unindexed multi-table join**: `tasks` joined to `projects` and `users`, flagged as a selective sequential scan

## Fix the test asserts

The N+1's count query gets a verified composite index: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_project_id_status" ON "tasks" ("project_id", "status");`.
The test requires a verdict of `PASS` and an index scan in the plan after the change (`Seq Scan on tasks` before, `Bitmap Index Scan` after).

In the run I recorded the speedup was **3.3x** at this 1/10 scale. The test asserts that the fix passes the gate (a lower bound of at
least 1.5x), not that number, and it varies from run to run. At full scale the speedup was not measured.

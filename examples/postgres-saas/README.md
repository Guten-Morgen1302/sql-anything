# postgres-saas (synthetic)

A multi-tenant SaaS API on Postgres with the three classic bottlenecks and 100k+ rows. **The data is synthetic and the slowness
is staged.** It shows the loop; it is not a benchmark of your app.

```bash
cd examples/postgres-saas
npm install
npm run setup          # random local password into .env, docker compose up -d --wait, then seed (324,020 rows: 120,000 tasks, 200,000 comments, 2,000 users, 2,000 projects, 20 tenants)
PORT=3000 npm start    # the API
```

No password is stored in the repository. `npm run setup` generates one into a git-ignored `.env`, and Docker Compose and the example
read it from there. `docker-compose.yml` runs `postgres:17`, published on `127.0.0.1:54330` only, with no volume: `npm run teardown`
gives you a clean database next time. `node db.mjs` prints the connection URL.
No Docker? Point the example at a Postgres you already have: `DATABASE_URL=postgres://... SEED_SCALE=0.1 node seed.mjs` seeds a 10x smaller copy.

| Endpoint | Bottleneck |
|---|---|
| `GET /api/tenants/1/projects` | **N+1 in a driver loop**: one `count(*)` on `tasks` per project |
| `GET /api/tenants/1/overdue` | **unindexed multi-table join**: `tasks` ⋈ `projects` ⋈ `users`, filtered on unindexed `status`, `due_date` |
| `GET /api/tenants/1/dashboard` | **correlated subquery**: a comment count recomputed for every project row |

```bash
B=http://127.0.0.1:3000/api/tenants/1
npx sql-anything go --db "$(node db.mjs)" --agent claude \
  --hit $B/projects --hit $B/overdue --hit $B/dashboard \
  --check-url "http://127.0.0.1:{port}/api/tenants/1/projects" --run "node server.mjs" \
  -- node server.mjs
```

The repository's test suite seeds this example at 1/10 scale into a real Postgres and asserts that scan reports all three
bottlenecks (the N+1 with its `file:line`, the correlated subquery, the unindexed join) and that the N+1's count query gets a
verified composite index. The one-command setup, the compose file and a `go` run against them were run once by hand on Docker Desktop
(Windows, Docker 29.3.1): [docs/benchmarks/postgres-saas/RESULTS.md](../../docs/benchmarks/postgres-saas/RESULTS.md). The compose path is not
exercised by CI, and Linux and macOS Docker are untested.

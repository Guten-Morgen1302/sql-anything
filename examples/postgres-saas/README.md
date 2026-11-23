# postgres-saas (synthetic)

A multi-tenant SaaS API on Postgres with the three classic bottlenecks and 100k+ rows. **The data is synthetic and the slowness
is staged.** It shows the loop; it is not a benchmark of your app.

```bash
cd examples/postgres-saas
npm install
npm run setup          # docker compose up -d --wait  +  seed (≈ 640k rows: 120k tasks, 200k comments, ...)
PORT=3000 npm start    # the API
```

`docker-compose.yml` runs `postgres:17` on port 54330 and has no volume: `npm run teardown` gives you a clean database next time.
No Docker? `SEED_SCALE=0.1 node seed.mjs <postgres-url>` seeds a 10x smaller copy into any Postgres you already have.

| Endpoint | Bottleneck |
|---|---|
| `GET /api/tenants/1/projects` | **N+1 in a driver loop**: one `count(*)` on `tasks` per project |
| `GET /api/tenants/1/overdue` | **unindexed multi-table join**: `tasks` ⋈ `projects` ⋈ `users`, filtered on unindexed `status`, `due_date` |
| `GET /api/tenants/1/dashboard` | **correlated subquery**: a comment count recomputed for every project row |

```bash
B=http://127.0.0.1:3000/api/tenants/1
npx sql-anything go --db postgres://saas:saas@localhost:54330/saas --agent claude \
  --hit $B/projects --hit $B/overdue --hit $B/dashboard \
  --check-url "http://127.0.0.1:{port}/api/tenants/1/projects" --run "node server.mjs" \
  -- node server.mjs
```

The repository's test suite seeds this example at 1/10 scale into a real Postgres and asserts that scan reports all three
bottlenecks (the N+1 with its `file:line`, the correlated subquery, the unindexed join) and that the N+1's count query gets a
verified composite index. The `docker-compose.yml` itself is not exercised by CI.

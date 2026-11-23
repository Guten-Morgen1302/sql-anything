# sqlite-shop (synthetic)

A small shop API that is slow on purpose, so you can watch sql-anything find and fix it. **The data is synthetic and the
slowness is staged. This shows the loop; it is not a benchmark of your app.** Zero Docker, zero dependencies: Node 22.13+ and
its built-in `node:sqlite`.

```bash
cd examples/sqlite-shop
node seed.mjs shop.db                 # 2,000 customers, 100,000 orders, ~200,000 order items (about 2 s)
PORT=3000 SQL_ANYTHING_DB_URL=shop.db node server.mjs   # in one terminal
```

The three pathologies:

| Endpoint | Problem |
|---|---|
| `GET /api/regions/r01/leaderboard` | **N+1**: one `count(*)`/`sum()` query per customer in the region (41 queries per request) |
| same query, per customer | `orders.customer_id` has **no index**, so each lookup scans 100,000 rows |
| `GET /api/customers/7/orders?status=paid` | unindexed **multi-column filter** (`customer_id`, `status`) |

Run the whole loop, no agent and no API key needed (the code-level N+1 fix uses a recorded fix, `reference-agent.mjs`, instead of an LLM):

```bash
npx sql-anything demo                  # self-contained copy of this example, about 15 s
```

Or point the real thing at it:

```bash
npx sql-anything go --db shop.db --agent claude \
  --hit "http://127.0.0.1:3000/api/regions/r01/leaderboard" \
  --hit "http://127.0.0.1:3000/api/customers/7/orders?status=paid" \
  --check-url "http://127.0.0.1:{port}/api/regions/r01/leaderboard" --run "node server.mjs" \
  -- node server.mjs
```

`{port}` in `--check-url` lets sql-anything start the original and the patched server side by side on free ports and
interleave requests between them.

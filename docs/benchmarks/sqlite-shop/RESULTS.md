# examples/sqlite-shop: a verified run with the real `claude` CLI

**Synthetic data, staged slowness.** This is the reproducible example, not a real application. It shows the loop working end to
end. The numbers below are copied from the run's own `patch.json` files; the cards are the unedited `report` output.

| | |
|---|---|
| App | [`examples/sqlite-shop`](../../../examples/sqlite-shop) (zero dependencies, `node:sqlite`) |
| Data | 2,000 customers, 30,000 orders (`seed(file, { orders: 30000 })`), about 60,000 order items. The shipped `seed.mjs` defaults to 100,000 orders |
| Traffic | 3 requests to `GET /api/regions/{r01,r02,r03}/leaderboard` |
| Command | `sql-anything go --db shop.db --agent claude --max-fixes 2 --hit <url> ... --run "node server.js" --check-url "http://127.0.0.1:{port}/api/regions/r01/leaderboard" -- node server.js` |
| Agent | the real `claude` CLI (`claude -p --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep`), 1 attempt |
| Machine | Windows 11, Node 24.10, local disk |
| Captured | 164 statements |

## Cards

| Fix | Card |
|---|---|
| F1: index on `orders(customer_id)` | [card-index.svg](../../assets/card-index.svg) |
| F2: the N+1 loop rewritten by `claude` | [card-n1-claude.svg](../../assets/card-n1-claude.svg) |

## F1: deterministic index (no LLM)

`CREATE INDEX IF NOT EXISTS "idx_orders_customer_id" ON "orders" ("customer_id");`

| | before | after |
|---|---:|---:|
| p50 | 5.645 ms | 0.405 ms |
| p95 | 7.977 ms | 0.638 ms |
| plan | `SCAN orders` | `SEARCH orders USING INDEX idx_orders_customer_id (customer_id=?)` |

- Speedup **13.93x**, 95% CI lower bound **13.40x**, n = 360 interleaved samples. Gate needs a lower bound of 1.5x.
- Parity: **123/123 replayed inputs identical** (row parity). Regression guard: no other fingerprint slower than the A/A noise floor.
- Write guard: **skipped**, because this traffic captured no writes. The 15% write guard only runs when writes were captured.
- Shadow method: `file-snapshot` (`VACUUM INTO`), seed 1.

## F2: N+1 fixed by the real `claude` CLI

The loop in `leaderboard()` ran one `select count(*) ... where customer_id = ?` per customer (40 per request). `claude` rewrote it
into a grouped query. Changed file: `server.mjs` only (saved as `fix.patch`; `git apply -R` reverts it).

| | before | after |
|---|---:|---:|
| p50 (endpoint wall time) | 244.093 ms | 13.599 ms |
| p95 | 259.930 ms | 18.786 ms |
| SQL statements per request | 41 | 2 |

- Speedup **17.95x**, 95% CI lower bound **16.42x**, n = 15 interleaved runs.
- Parity: **15/15 runs identical** to baseline (canonicalized JSON, 0 noisy paths masked). Regression: patched/baseline 0.06x.
- Measured end to end: the original and the patched server ran side by side on two clones of the database, requests interleaved.

## What the run does not show

- One run, one machine, no repetition across seeds. Timings vary run to run; the demo (`npx sql-anything demo`, 30,000 orders) printed
  10.2x to 12.9x for the index fixes and 2.7x to 2.9x for the N+1 across two 30,000-order runs.
- The hook's own overhead (about 3 microseconds per statement) is inside every timing.
- Synthetic data is cleaner than any real database. For a real application and what the gate refused there, see
  [../conduit/RESULTS.md](../conduit/RESULTS.md).

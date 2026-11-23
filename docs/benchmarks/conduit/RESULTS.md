# Real app: conduit-realworld-example-app (Express 5 + Sequelize 6 + Postgres)

Local run, nothing uploaded, no upstream PRs. This is a log of what happened, including what the gate refused.

| | |
|---|---|
| App | [TonyMckes/conduit-realworld-example-app](https://github.com/TonyMckes/conduit-realworld-example-app), commit `5e127d8`, MIT. A RealWorld reference implementation: small, not a production system |
| Stack | Express 5.2, Sequelize 6.37, `pg` 8.20, Node 24.10, Windows 11 |
| Database | Postgres (embedded build, local). Schema created by the app itself (`sequelize.sync`). Data: [seed.sql](seed.sql), synthetic, deterministic: 3,000 users, 120,000 articles, 240,000 tag links, 120,000 favorites, 150,000 comments (about 636k rows) |
| Traffic | 5 `GET /api/articles...` and `/api/tags` URLs (list, offset, by tag, by author), each twice, through the hook |
| Installed with | `npm install --ignore-scripts` into a temp directory outside this repository |

## Scan (real findings, no setup in the app)

```
captured 2,176 statements, 34 transaction/health-check/schema-introspection statements ignored
F1  slow-query           5 calls   1,312 ms total   article listing (ORDER BY createdAt DESC + tag/author joins) at controllers/articles.js:54
F2  correlated-subquery  2 calls     842 ms total   same listing with an author filter, plan re-runs a subplan per row
F3  slow-query           5 calls     815 ms total   count(*) over the same joins (pagination total)
F4  seq-scan             2 calls     278 ms total
F5  n+1                350 calls     295 ms total   50 identical lookups per request, helper/helpers.js (favorites count per article)
F8  n+1                350 calls     251 ms total   50 identical lookups per request, helper/helpers.js (follower count per article)
```

Sequelize inlines values into the SQL text and sends no bind parameters. The first version of the N+1 detector judged by bind
params and **missed all of these**; it now keys on the statement text as well (regression test:
`test/unit/analyze.test.ts`). Findings F3 to F9 on the first scan were 50-lookup loops at four distinct call sites in `helpers.js`.

## Fixes: nothing verified, and why

| Attempt | Result | Reason (from the gate's own output) |
|---|---|---|
| Generated index candidates for F1, F2 | **rejected** | speed 0.99x, 1.10x, 0.98x (95% CI lower bound 0.90x to 0.96x, n=30; need 1.5x). The generator proposed weak indexes (`Tags(name)`, `Articles(id, userId)`); the gate refused them instead of letting a slow-neutral index through |
| Hand-written indexes on `Articles(createdAt DESC)`, `TagList(tagName)`, `Articles(userId)` through `fix --migration` | **rejected** | parity: 498 of 500 replayed inputs identical. 2 mismatches: *same rows, different order*. conduit's listing orders by `createdAt` but joins tags, so one article appears once per tag; the SQL does not pin the order of those rows, and a new plan changes it, which changes the order of `tagList` in the JSON |
| Real `claude` CLI on the N+1 / listing code (2 attempts, end-to-end check) | **rejected** | parity on the JSON output: `$.articles[12].tagList[0]`: baseline `"tag8"` vs patched `"tag25"`. Same cause: tag order inside an article is whatever the heap returned. The agent was told and did not converge in 2 attempts |

Read this as: on this app the gate found a real latent ordering dependency. An index or a batched query can be faster and still
reorder `tagList`. Whether that matters is the owner's call, and `verify` will not make it for them. The fix is to pin the order
in the query (for example `ORDER BY "createdAt" DESC, "id" DESC` and an ordered tag subquery), after which these same patches
can be re-verified.

## One gate bug this run found and fixed

The first deterministic run was rejected on "row count 1 vs 2" for an input that no patch touched. It was Sequelize's start-up
schema introspection (`information_schema...`), which legitimately returns different rows once an index exists. Schema
introspection queries are now excluded from parity and from findings (`isIntrospection`, unit-tested).

## What this run does not show

- No verified speedup on a real application. The reproducible, synthetic examples do (see `docs/assets/` and the README), the real app did not.
- One app, one reference implementation, one database size. Not a survey.
- The second candidate app (`tanem/express-bookshelf-realworld-example-app`) was not run.
- Timings are from a laptop with an embedded Postgres build and include the capture hook's overhead.

## Reproduce

```bash
git clone https://github.com/TonyMckes/conduit-realworld-example-app && cd conduit-realworld-example-app/backend
npm install --ignore-scripts
export DEV_DB_USERNAME=... DEV_DB_PASSWORD=... DEV_DB_NAME=conduit DEV_DB_HOSTNAME=localhost DEV_DB_DIALECT=postgres
node index.js            # once, so sequelize.sync creates the schema; stop it
psql "$DATABASE_URL" -f path/to/seed.sql
npx sql-anything scan --db "$DATABASE_URL" --hit "http://127.0.0.1:3001/api/articles?limit=50" -- node index.js
```

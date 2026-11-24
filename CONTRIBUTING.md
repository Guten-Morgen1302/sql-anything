# Contributing

Thanks for helping. sql-anything's one rule: **nothing is reported as a win unless it was replay-verified.** Most review comments
come back to that.

## Setup

Needs Node 22.13 or newer (24 recommended) and git. Docker is not required: the Postgres tests start an embedded Postgres.

```bash
git clone https://github.com/Guten-Morgen1302/sql-anything && cd sql-anything
npm ci
npm run build          # tsc -> dist/
```

The CLI from your checkout: `node dist/src/cli.js <command>`. Try `node dist/src/cli.js demo`.

Source is TypeScript under `src/`, tests under `test/`. Both compile into `dist/` (`dist/test/**` is never published).

## Running tests

| Command | What runs | Typical time |
|---|---|---|
| `npm run test:unit` | pure logic: SQL normalizer and classifier, typed params, canonical row comparison, bootstrap statistics, stack capture, report card, N+1 detector | about 1 s |
| `npm run test:sqlite` | build + unit + every `*.sqlite.test.ts` (capture hook, scan, verify and the **trap suite** on SQLite, the fix/agent loop with a scripted agent, `go`, MCP) | 2 to 4 min |
| `npm run test:integration:pg` | every `*.pg.test.ts`: the **trap suite on real Postgres**, scan on pg, Prisma 7, the postgres-saas example, connection redirect | 6 to 8 min |
| `npm test` | everything above | 8 to 12 min |

Postgres tests use an **embedded Postgres** by default. To use a server you already have (CI does), point them at it with a
superuser URL; they create and drop their own `sa_*` databases:

```bash
SA_TEST_PG_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:integration:pg
```

Notes:
- Integration tests are serial (`--test-concurrency=1`) on purpose. They measure timings, and parallel Postgres clones starve each other.
- The Prisma 7 test generates a client as TypeScript and runs it with Node's type stripping: use Node 22.18+ or 24.
- The integration scripts pass `--test-force-exit`: the embedded Postgres can leave a worker process holding a pipe open after
  `stop()`, which keeps a finished test file's process alive and stalls the whole run (seen on Windows). If you invoke
  `node --test` yourself on a `*.pg.test.js` file, add the flag too.
- If a run is killed, stray `postgres` processes can survive and slow the next run. Stop them before retrying.
- Timing-based tests use large effect sizes and confidence bounds, but a heavily loaded machine can still flap one. Re-run before assuming a bug, and tell us if it flaps repeatedly.

### The trap suite

`test/integration/traps.ts` is the heart of the project. Each case is a patch that *looks* like an optimization and is wrong
(`NOT IN` vs `NOT EXISTS` with a NULL, `LEFT` to `INNER JOIN`, duplicate rows, tie-order drift, volatile `now()`/`random()`, a
rewrite that is slower, a speedup that costs another query, an index that slows writes, a UNIQUE index that breaks a captured
insert), plus positive controls proving the gate is not just rejecting everything. It runs against SQLite and Postgres from the same
definitions (`traps.sqlite.test.ts`, `traps.pg.test.ts`).

**If you change anything under `src/verify/`, add or extend a trap.** A change that makes `verify` accept more must come with a
case that shows it still rejects the wrong thing.

## Documentation is part of the change

A change to a **command, flag, exit code, MCP tool, supported driver, gate threshold or benchmark result** updates `README.md`,
`skills/sql-anything/SKILL.md` and `CHANGELOG.md` in the same commit. `test/unit/readme-sync.test.ts` fails `npm test` (and CI) when the README
or the skill drifts from the CLI's `--help`, the parser's flags, `src/meta.ts` (`COMMANDS`, `EXIT`), the registered MCP tools, or the files under
`docs/benchmarks/`, and when a relative link or image is broken. Every number in the README must come from a file under `docs/benchmarks/`:
record the artifact first, then quote it. The README says what was not tested.

## Pull requests

- Keep a PR to one change. Describe the user-visible behaviour and how you tested it.
- Add or update tests. A bug fix starts as a failing test.
- Run `npm test` (or at least `npm run test:sqlite` plus the Postgres tests if you touched Postgres paths).
- Do not weaken a gate threshold, loosen a comparison, or add a "skip" to make a test pass. If a threshold is wrong, change it in
  its own PR with the evidence.
- Reports and cards must never contain parameter values or absolute paths. See [SECURITY.md](SECURITY.md).
- Do not commit traces, `.env` files, database files, planning notes or `spikes/`. `npm run check:pack` fails if the tarball would
  contain anything it should not.

## Adding a driver hook

A **driver hook** makes queries from a database client library visible to sql-anything. All hooks live in
`src/hook/install.ts` and share three helpers: `begin(sql)` (starts timing, captures the call site and the HTTP request context),
`record(db, op, call, args, extra)` (writes one trace record) and `encodeParams` (typed parameters: Date, BigInt, Buffer).

### A new client for an engine we already replay (for example `postgres.js` or `slonik` for Postgres)

Only the hook is needed.

1. **Find the choke point.** Where does every query pass? For `pg` it is `Client.prototype.query`. For `better-sqlite3` it is the
   prepared statement's `run/get/all/iterate`. Wrap the shared prototype, not instances, so ESM and CJS importers are both covered.
2. **Write `patchXxx(module)` in `install.ts`.** Mirror `patchPg`:
   - call `begin(sql)` **at call time**, not at completion. Completion callbacks run in a different async context and stack, so
     the request id and call site would be wrong (this bug already happened once with `pg.Pool`);
   - handle **every calling convention** the library has (callback, promise, streaming/cursor: pass cursors through untraced until supported);
   - call `record('xxx', op, c, params, { rows, err })` in a `finally`, inside `try/catch`;
   - never change arguments, return values or thrown errors, and never let a tracing failure propagate.
3. **Register it** in both places: the eager resolution loop (`for (const [name, fn] of [...])`, which patches the shared prototypes
   from your app's directory) and the `Module._load` fallback. ESM `import` of a CJS package does not go through `Module._load`, which is
   why the eager path exists.
4. **Extend the types.** Add the driver name to the `db` union in `src/trace/types.ts`.
5. **Test it end to end** with a fixture app under `test/fixtures/` run through `capture(...)`, like `hook-probe.ts`
   (all calling conventions, error pass-through, call-site line, request grouping, worker threads, `SQL_ANYTHING_DISABLE=1`).
   `test/integration/hook.sqlite.test.ts` and `scan.pg.test.ts` are the templates. Test with the ORMs people actually use on top of it.
6. Document it in the README's supported list and in `CHANGELOG.md`.

### A new database engine (for example `mysql2` for MySQL)

The hook is the easy part. sql-anything must also **clone, replay and explain** the engine, so you also need:

- `src/db/conn.ts`: a `Conn` implementation (`query`, `exec`, `close`) that returns every value in a form that compares exactly
  (Postgres returns raw text for this reason);
- `src/db/shadow.ts`: how to make isolated clones and drop them without touching the source;
- `src/scan/explain.ts`: plan facts (selective full scans, correlated subqueries) from that engine's `EXPLAIN`;
- `src/sql/classify.ts`: engine-specific volatile functions and introspection tables;
- the trap suite running on the new engine from `test/integration/traps.ts` (add `traps.mysql.test.ts`).

Please open a **driver request** issue first so we can agree on the design.

## Style

TypeScript, strict. No new runtime dependencies without discussion (the dependency list is deliberately three packages).
Prefer explicit over clever. Comments explain *why*, not what.

## Releasing (maintainers)

`CHANGELOG.md` is updated in the PR that changes behaviour. Before a release: `npm test`, `npm run check:pack`, then
`npm pack` and run the tarball in a clean folder (`npx --package ./sql-anything-x.y.z.tgz sql-anything demo`).

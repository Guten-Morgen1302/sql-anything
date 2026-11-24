# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private vulnerability reporting:

<https://github.com/Guten-Morgen1302/sql-anything/security/advisories/new>

Include the version (`npx sql-anything --help` prints the commands; `npm ls sql-anything` the version), your Node version and OS,
what you did, and what you expected. A minimal reproduction helps most. Please do not attach real traces or database contents:
traces hold real query parameters (see below).

This is a small, early-stage project maintained by volunteers. There is no bug bounty and no response-time guarantee; reports
are read and handled as soon as possible.

| Version | Supported |
|---|---|
| 0.1.x | yes, fixes land on the latest 0.1 release |

## What sql-anything is, and what it touches

sql-anything runs **on your machine, next to your app**. It has no server, no account, and no hosted component.

1. **Capture hook.** `NODE_OPTIONS=--import` loads a small module into *your app's own process*. It wraps `pg`, `better-sqlite3`
   and `node:sqlite` and writes every statement, its parameters, timing and call site to local files.
2. **Analysis and verification.** It reads those files, makes **clones** of your database, runs `EXPLAIN` and replays queries on
   the clones, and writes findings and reports.
3. **Optional agent.** `--agent claude` (or `--agent-cmd`) starts the agent CLI you chose, in a git worktree, to propose a code change.

## Threat model and guarantees

### Zero telemetry, local only

- sql-anything makes **no network requests of its own**: no telemetry, no update check, no crash reporting. The only `fetch` calls
  in the source are `GET` requests to the URLs *you* pass with `--hit` / `--check-url` (normally `127.0.0.1`).
- It connects only to the databases you point it at (`--db`) and the clones it creates from them.
- Anything the **agent CLI** sends over the network (for example, Claude Code talking to its API) is that tool's behaviour and
  governed by its own policy, not by sql-anything. What sql-anything puts into the prompt is described below.
- The MCP server speaks over stdio to the process that started it. It opens no port.

### What is written to disk, and what is safe to share

| Artifact | Contains | Share it? |
|---|---|---|
| `.sql-anything/runs/*/trace.*.jsonl` | **real query parameter values**, SQL text (possibly with literal values: some ORMs inline them), call sites as absolute paths | **No.** Treat like a database dump. The directory git-ignores itself (`.sql-anything/.gitignore` is `*`) |
| `findings.json` | normalized SQL (literals replaced by `?`), absolute call-site paths, timings | Local use; review before sharing |
| `verify.json`, `fixes/*/patch.json` | normalized SQL (value-free), gate measurements, plan summaries (table and index names) | Generally yes, review first |
| `report/report.md`, `report/card-*.svg` | **no parameter values, no absolute paths** (call sites are made relative to the project; SQL is the normalized form), measured numbers, plan summaries | Yes: designed to be pasted into a PR or posted |
| `fix.patch`, `migration.sql`, `down.sql` | the code or SQL change itself | Yes, it is your diff |

The report guarantees are covered by tests: `test/integration/fix.sqlite.test.ts` asserts the SVG and the Markdown contain no absolute
path, and `test/integration/traps.ts` asserts result files carry the normalized SQL (values replaced by `?`), which is the only SQL
the cards and reports ever print. They hold for the files above as generated. They cannot cover free text you add yourself (for example `--label`) or a migration you wrote by hand.

### Your database is read-only to sql-anything, with one documented exception

- **SQLite:** the source file is opened read-only (`VACUUM INTO` a temp file). `EXPLAIN` and replay run on temp copies.
- **Postgres, normal case:** `CREATE DATABASE ... TEMPLATE <source>` creates local clones (needs the `CREATEDB` privilege). The
  source is only read. All `EXPLAIN ANALYZE`, `ANALYZE`, migrations and write-replay happen on clones, which are dropped afterwards.
- **Postgres, fallback:** if the source database has other open connections, `TEMPLATE` is impossible and sql-anything **never
  disconnects other sessions**. It then creates temporary `sa_shadow_*` **schemas inside the source database** (needs `CREATE`
  on it), copies the tables with `CREATE TABLE ... (LIKE ...)` + `INSERT ... SELECT`, works in those schemas, and drops them.
  This writes to the source database for the duration of the run, and it prints a warning when it happens. Use a development
  database, stop the app, or give the connection a role that cannot create schemas to forbid it.
- A **non-local Postgres host is refused** by default, because the clone would copy that database's data to wherever the
  server runs. `--allow-remote-shadow` overrides it. **Never point sql-anything at production.** Use a dev or staging copy.
- `EXPLAIN ANALYZE` executes the statement. It only ever runs on a clone, never on your source database.
- Nothing is applied to your repository or database for you. A verified index comes as `migration.sql` / `down.sql`; a code fix as
  `fix.patch`. You apply them.

### The capture hook runs inside your app

- It records SQL text and parameters (that is its job), writes them to a local directory (`.sql-anything/runs/...` or
  `SQL_ANYTHING_TRACE_DIR`), and passes results and exceptions through unchanged. A failure inside the hook is swallowed so it
  cannot take your app down.
- `SQL_ANYTHING_DISABLE=1` makes it do nothing at all (no patching, no files). Run production-like load with it off unless you are
  profiling on purpose.
- It adds roughly 3 µs per query. It should be used in development and staging, not left on in production.
- `SQL_ANYTHING_PG_REDIRECT` (set by `verify` for its own child processes) points `pg` connections at a clone. It is an internal
  variable; if you set it yourself, your app will connect there.

### Agents

- The agent runs in a **git worktree** of your repository, so every change is an isolated, reviewable diff, and a rejected attempt
  leaves your working tree untouched. A dirty working tree is refused.
- Its environment has the database connection variables removed (`DATABASE_URL`, `PG*`, `POSTGRES*`, `DB_*`, `MYSQL*`,
  `SQL_ANYTHING_DB_URL`, `NODE_OPTIONS`, the trace directory). It is told it has no database access.
- The prompt contains the **normalized** statement (no values), the call site relative to your project, the finding detail, and the
  plan summary. It never contains parameter values from traces.
- `--agent claude` starts `claude -p --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep`. **sql-anything does
  not sandbox the agent beyond what that CLI enforces.** It can read your project files in the worktree and, as with any coding agent,
  what it reads may be sent to its model provider. Do not run it on a repository whose contents you cannot send to that provider.
- Every agent change must pass the same verification gate as any other change. A "verified" result is evidence about query results
  and timing on a clone. It is **not a security review** of the generated code: read `fix.patch` before applying it.

### Running your app and commands

`scan`, `go`, `fix` and `verify` run the command you give them (your app, `--run`, `--check-cmd`, `--agent-cmd`) with your
privileges. Pass only commands you would run yourself.

## Out of scope

Vulnerabilities in your database server, in the agent CLI, or in dependencies of your own application. Findings that require an
attacker who can already run code as your user or write to `.sql-anything/` or `NODE_OPTIONS`. Denial of service by pointing the
tool at a database too large to clone.

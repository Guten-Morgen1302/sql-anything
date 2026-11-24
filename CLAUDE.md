## gstack

Use the /browse skill from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.

## Documentation must change with the code (standing rule)

Any commit or PR that adds, removes or changes a **CLI command, a flag, an exit code, an MCP tool, a supported driver or stack, a
gate threshold, or a benchmark result** MUST update all three of these in the **same commit**, before you finish:

1. `README.md`
2. `skills/sql-anything/SKILL.md`
3. `CHANGELOG.md`

How the rule is enforced: `test/unit/readme-sync.test.ts` (part of `npm test` and CI) fails when
- a subcommand in `src/meta.ts` (`COMMANDS`) is missing from the README CLI table, or the README documents one that does not exist;
- a flag the parser in `src/cli.ts` accepts is not mentioned in `README.md`, or a flag in `README.md`, `--help` or `SKILL.md` does not exist;
- an MCP tool registered by `src/mcp.ts` is missing from the README tool table or `SKILL.md`;
- the exit codes in `src/meta.ts` (`EXIT`) differ from the README table, `--help`, or `SKILL.md`;
- a relative link, image or in-page anchor in the docs does not resolve;
- a speedup or `N/N` count quoted in `README.md` does not appear in a file under `docs/benchmarks/`.

So: change the code, change the docs, run `npm test`. Do not edit the test to make it pass, loosen it, or delete a check; if a check is
wrong, fix it in its own commit and say why. A new command goes in `COMMANDS` and in the `HANDLERS` map in `src/cli.ts` (it does
not compile otherwise). A new exit code goes in `EXIT`.

README rules: every command, flag, exit code and number must be checked against the real CLI (`node dist/src/cli.js --help`) and the real
files in `docs/benchmarks/`. Never invent, round up, or estimate a number; if a number has no artifact, record the artifact first.
Say what was not tested. No hype words.

## Other standing rules

- Nothing is reported as a win unless it was replay-verified. Do not weaken a gate to make a test pass; add a trap in
  `test/integration/traps.ts` when you change `src/verify/`.
- Reports, cards and MCP results carry normalized SQL only: no parameter values, no absolute paths.
- Do not commit planning docs, `spikes/`, traces, `.env` files or database files (`npm run check:pack` guards the tarball).
- Do not push or publish unless the user asks.

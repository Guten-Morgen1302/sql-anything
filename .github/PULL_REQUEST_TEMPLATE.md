## What and why

<!-- The user-visible behaviour this changes, and the problem it solves. Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran and what you saw. Paste the final summary of `npm test` (or the parts you ran). -->

## Checklist

- [ ] Tests added or updated (a bug fix starts as a failing test)
- [ ] `npm test` passes locally (or I explained which part I could not run)
- [ ] If this touches `src/verify/`: I added or extended a **trap** in `test/integration/traps.ts`, and the gate still rejects the wrong patches
- [ ] I did **not** weaken a gate threshold, loosen a comparison or skip a test to get green
- [ ] No parameter values or absolute paths can reach a report, card or MCP result
- [ ] `npm run check:pack` passes; I did not add traces, `.env`, database files, planning notes or `spikes/`
- [ ] If I added or changed a command, flag, exit code, MCP tool, supported driver, gate threshold or benchmark number: `README.md`, `skills/sql-anything/SKILL.md` and `CHANGELOG.md` are updated in this PR (`test/unit/readme-sync.test.ts` checks the first two)
- [ ] New driver hook: it handles every calling convention, never changes the app's results or errors, and has an end-to-end fixture test (see CONTRIBUTING.md)

## Notes for the reviewer

<!-- Risks, trade-offs, anything you are unsure about. -->

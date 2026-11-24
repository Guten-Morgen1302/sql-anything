/**
 * The public surface that README.md and skills/sql-anything/SKILL.md describe. It lives in its own module (the CLI entry
 * runs on import, so tests cannot import it) and `test/unit/readme-sync.test.ts` fails the build when the docs drift from it.
 */

/** Every subcommand. cli.ts has a handler map typed against this list, so a command cannot exist without being listed. */
export const COMMANDS = ['go', 'scan', 'fix', 'verify', 'bench', 'report', 'mcp', 'demo'] as const;
export type Command = (typeof COMMANDS)[number];

/** Process exit codes. Documented in README.md; the drift test compares the table with this object. */
export const EXIT = {
  /** ran; verified win, or nothing to fix */
  OK: 0,
  /** a patch was rejected by the verification gate */
  REJECTED: 2,
  /** usage or environment error */
  USAGE: 3,
  /** nothing captured, or the result cannot be verified */
  UNVERIFIABLE: 4,
} as const;

export type Verdict = 'PASS' | 'REJECT' | 'UNVERIFIABLE';

export function verdictExit(v: Verdict): typeof EXIT.OK | typeof EXIT.REJECTED | typeof EXIT.UNVERIFIABLE {
  return v === 'PASS' ? EXIT.OK : v === 'REJECT' ? EXIT.REJECTED : EXIT.UNVERIFIABLE;
}

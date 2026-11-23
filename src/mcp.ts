/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runScan, runVerify, loadFindings } from './api.js';
import { latestRunDir } from './capture.js';
import { fix } from './fix/fix.js';
import { writeReport } from './report/report.js';
import { check } from './verify/check.js';
import { parseTarget } from './db/conn.js';

const text = (o: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }], ...(isError ? { isError: true } : {}) });
const safe = (fn: (a: any) => Promise<unknown>) => async (a: any) => {
  try {
    return text(await fn(a));
  } catch (e: any) {
    return text({ error: String(e?.message ?? e) }, true);
  }
};
const runDirOf = (t?: string) => {
  const d = t ? path.resolve(t) : latestRunDir();
  if (!d) throw new Error('no captured run: call scan first');
  return d;
};

/**
 * MCP tools for an agent that is already doing the work: scan to find, verify to prove, fix for the deterministic
 * index path, report for the PR block. The agent edits code itself; this server never edits your source and never
 * returns parameter values (only normalized SQL).
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: 'sql-anything', version: '0.1.0' });

  server.registerTool(
    'scan',
    {
      title: 'Scan an app for slow SQL and N+1',
      description:
        'Runs the app command with the capture hook (or analyzes an earlier trace), then returns ranked findings: N+1 loops with the exact file:line, selective sequential scans, correlated subqueries, slow statements. Findings contain normalized SQL only, never parameter values. Exit semantics: an empty capture is an error, not "no findings".',
      inputSchema: {
        command: z.array(z.string()).optional().describe('app command and args, e.g. ["node","server.js"]'),
        trace: z.string().optional().describe('analyze this run directory instead of launching the app'),
        db: z.string().optional().describe('sqlite file or postgres:// URL, used for EXPLAIN on a clone (never the live database)'),
        hits: z.array(z.string()).optional().describe('GET URLs to request once the server is up'),
        hitRepeat: z.number().int().min(1).max(500).optional(),
        duration: z.string().optional().describe('e.g. "20s"'),
        cwd: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async (a) => {
      const r = await runScan({ cmd: a.command, trace: a.trace, db: a.db, hits: a.hits, hitRepeat: a.hitRepeat, duration: a.duration, cwd: a.cwd });
      if (r.exitCode !== 0) return { exitCode: r.exitCode, run: r.dir, error: r.error };
      return { exitCode: 0, run: r.dir, captured: r.report!.captured, findings: r.report!.findings.map(({ plan, ...f }) => ({ ...f, planSummary: plan?.summary })), warnings: r.report!.warnings };
    }),
  );

  server.registerTool(
    'verify',
    {
      title: 'Replay-verify a SQL patch',
      description:
        'Replays captured queries on two clones of the database, before and after your patch (a migration and/or SQL rewrites keyed by fingerprint). Gates: row-for-row parity, interleaved speedup (95% CI lower bound), no regression elsewhere, write guard. Never modifies the source database. verdict PASS (exitCode 0), REJECT (2: read `gates` and `mismatches`, fix the cause), UNVERIFIABLE (4: volatile functions, LIMIT without ORDER BY, too few samples). Never claim a fix is verified unless verdict is PASS.',
      inputSchema: {
        db: z.string(),
        trace: z.string().optional(),
        migration: z.string().optional().describe('DDL applied to the patched clone only'),
        rewrites: z.record(z.string(), z.string()).optional().describe('fingerprint -> replacement SQL with the same placeholders'),
        target: z.array(z.string()).optional().describe('finding ids (F1) or fingerprints the patch should speed up'),
        minSpeedup: z.number().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const { result } = await runVerify({ db: a.db, trace: a.trace, migrationSql: a.migration, rewrites: a.rewrites, target: a.target, minSpeedup: a.minSpeedup });
      return result;
    }),
  );

  server.registerTool(
    'verify_workload',
    {
      title: 'Verify an N+1 / application-code fix end to end',
      description:
        'Runs the app before and after your code change (two checkouts, e.g. git worktrees) against identical database clones and compares canonicalized JSON/stdout, wall time (interleaved) and SQL statements per run. Use checkUrl with run for a read-only GET (put {port} in the URL so both servers run side by side) or checkCmd for a one-shot command.',
      inputSchema: {
        db: z.string(),
        baselineDir: z.string(),
        patchedDir: z.string(),
        run: z.array(z.string()).optional(),
        checkUrl: z.string().optional(),
        checkCmd: z.array(z.string()).optional(),
        reps: z.number().int().min(5).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => check({ db: parseTarget(a.db), baselineDir: path.resolve(a.baselineDir), patchedDir: path.resolve(a.patchedDir), runCmd: a.run, checkUrl: a.checkUrl, checkCmd: a.checkCmd, reps: a.reps })),
  );

  server.registerTool(
    'fix',
    {
      title: 'Find a verified fix for a finding (deterministic index path)',
      description:
        'Tries deterministic CREATE INDEX candidates for a finding and returns the first one that passes the verify gate, with migration.sql and down.sql written under the run directory. It does not edit application code: for N+1 or query rewrites, change the code yourself in a separate worktree and call verify / verify_workload.',
      inputSchema: { finding: z.string().describe('finding id such as F1'), db: z.string(), trace: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const r = await fix({ runDir: runDirOf(a.trace), findingId: a.finding, db: a.db, agent: null });
      return { status: r.status, message: r.message, attempts: r.attempts, files: r.dir, migration: r.record?.migrationSql, down: r.record?.downSql, verdict: r.record?.verify?.verdict };
    }),
  );

  server.registerTool(
    'report',
    {
      title: 'Write the PR summary and SVG benchmark card',
      description: 'Writes report.md (PR block) and a dark-mode SVG card per verified fix in the run directory. Numbers come only from verified runs.',
      inputSchema: { trace: z.string().optional(), findings: z.array(z.string()).optional(), label: z.string().optional(), out: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async (a) => {
      const dir = runDirOf(a.trace);
      loadFindings(dir);
      const r = writeReport({ runDir: dir, ids: a.findings, label: a.label, outDir: a.out });
      return { files: r.files, markdown: r.markdown };
    }),
  );
  return server;
}

export async function serveStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

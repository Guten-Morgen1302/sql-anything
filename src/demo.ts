/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort } from './capture.js';
import { go, type GoOutcome } from './go.js';
import { EXIT } from './meta.js';
import { fmtMs, fmtX } from './report/card.js';

export interface DemoOptions {
  /** where the report and cards are written, default ./sql-anything-demo */
  out?: string;
  open?: boolean;
  keep?: boolean;
  log?: (s: string) => void;
}

export interface DemoOutcome {
  exitCode: 0 | 2 | 4;
  outDir?: string;
  seconds: number;
  go?: GoOutcome;
  files: string[];
  notes: string[];
}

const EXAMPLE = fileURLToPath(new URL('../../examples/sqlite-shop/', import.meta.url));

function openFile(file: string) {
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).on('error', () => {}).unref();
  } catch {
    /* no viewer: the path is printed anyway */
  }
}

/**
 * Zero-config showcase on a SYNTHETIC SQLite shop: seeds 100k orders, captures real requests, finds the N+1 and the
 * unindexed filters, fixes them (deterministic index candidates + a recorded code fix, no LLM, no network), runs every fix
 * through the same verification gate as a real run, and writes the report and SVG cards.
 */
export async function demo(o: DemoOptions = {}): Promise<DemoOutcome> {
  const log = o.log ?? (() => {});
  const t0 = performance.now();
  const notes: string[] = [];
  const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-anything-demo-'));
  const project = path.join(work, 'shop');
  fs.mkdirSync(project);
  for (const f of ['server.mjs', 'seed.mjs', 'reference-agent.mjs', 'package.json']) fs.copyFileSync(path.join(EXAMPLE, f), path.join(project, f));
  fs.writeFileSync(path.join(project, '.gitignore'), 'shop.db\n.sql-anything/\n');
  const stamp = () => `[${((performance.now() - t0) / 1000).toFixed(1).padStart(4)}s]`;
  const step = (s: string) => log(`${stamp()} ${s}`);
  try {
    step('seeding a synthetic shop: 2,000 customers, 30,000 orders (the examples/ apps ship 100,000)');
    const { seed } = await import(pathToFileURL(path.join(project, 'seed.mjs')).href);
    const counts = await seed(path.join(project, 'shop.db'), { orders: 30_000 });
    step(`seeded ${Object.entries(counts).map(([k, v]) => `${(v as number).toLocaleString('en-US')} ${k}`).join(', ')}`);

    if (hasGit) {
      const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=demo@example.com', '-c', 'user.name=demo', '-c', 'core.autocrlf=false', ...a], { cwd: project, stdio: 'ignore' });
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'sqlite-shop');
    } else notes.push('git was not found: the code-level N+1 fix is skipped (it needs a git worktree so it stays revertable); index fixes still run.');

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const hits = ['r01', 'r02', 'r03'].map((r) => `${base}/api/regions/${r}/leaderboard`).concat([1, 2, 3].map((i) => `${base}/api/customers/${i * 7}/orders?status=paid`));
    step('capturing real requests with the capture hook, then scanning (EXPLAIN runs on a clone, never on the live file)');
    const r = await go({
      cmd: [process.execPath, 'server.mjs'],
      cwd: project,
      db: path.join(project, 'shop.db'),
      env: { PORT: String(port) },
      hits,
      agent: hasGit ? { name: 'recorded fix (no LLM)', cmd: [process.execPath, 'reference-agent.mjs'] } : null,
      check: { runCmd: [process.execPath, 'server.mjs'], checkUrl: `${base.replace(String(port), '{port}')}/api/regions/r01/leaderboard`, reps: 6 },
      tuning: { samples: 40, rounds: 1, maxSeconds: 15 },
      maxFixes: 3,
      label: 'synthetic demo data',
      seed: 7,
      log: (s) => log(`${stamp()}   ${s}`),
    });
    if (r.error || !r.dir) {
      step(`stopped: ${r.error ?? 'nothing captured'}`);
      return { exitCode: EXIT.UNVERIFIABLE, seconds: (performance.now() - t0) / 1000, go: r, files: [], notes };
    }
    step(`found ${r.findings.length} finding(s); fixed ${r.fixes.filter((f) => f.status === 'verified').length} of ${r.fixes.length} that were attempted`);
    for (const f of r.fixes) {
      const rec = f.record;
      const sp = rec?.check?.wall.speedup.point ?? rec?.verify?.speed?.speedup.point;
      const q = rec?.check ? `, queries per request ${rec.check.queriesPerRun.baseline} -> ${rec.check.queriesPerRun.patched}` : '';
      log(`        ${f.findingId} ${f.status.padEnd(10)} ${rec ? `${rec.via === 'agent' ? 'code change' : 'index'} ${sp ? fmtX(sp) : ''}${q}` : f.message}`);
      if (rec?.migrationSql) log(`              ${rec.migrationSql}`);
    }

    const outDir = path.resolve(o.out ?? path.join(process.cwd(), 'sql-anything-demo'));
    const files: string[] = [];
    if (r.report) {
      fs.mkdirSync(outDir, { recursive: true });
      for (const f of r.report.files) {
        const dest = path.join(outDir, path.basename(f));
        fs.copyFileSync(f, dest);
        files.push(dest);
      }
      const card = files.find((f) => f.endsWith('.svg'));
      step(`report and ${r.report.cards.length} SVG card(s) written to ${outDir}`);
      for (const f of files) log(`        ${f}`);
      if (card && o.open !== false && process.stdout.isTTY) openFile(card);
      const best = r.fixes.filter((f) => f.record).map((f) => f.record!).sort((a, b) => (b.check?.wall.speedup.point ?? b.verify?.speed?.speedup.point ?? 0) - (a.check?.wall.speedup.point ?? a.verify?.speed?.speedup.point ?? 0))[0];
      if (best?.verify?.speed) log(`        e.g. ${best.findingId}: p50 ${fmtMs(best.verify.speed.baseP50Ms)} -> ${fmtMs(best.verify.speed.patchedP50Ms)}`);
    }
    notes.push('Synthetic data on purpose: this shows the loop, not a benchmark of your app. Run it on yours: sql-anything go --db <db> --agent claude --hit <url> -- <your app>');
    return { exitCode: r.exitCode, outDir: files.length ? outDir : undefined, seconds: (performance.now() - t0) / 1000, go: r, files, notes };
  } finally {
    if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
    else notes.push(`working copy kept at ${work}`);
  }
}

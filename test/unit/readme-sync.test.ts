/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { COMMANDS, EXIT } from '../../src/meta.js';
import { buildServer } from '../../src/mcp.js';
import { REPO } from '../helpers.js';

/**
 * Documentation drift guard. README.md, skills/sql-anything/SKILL.md and CHANGELOG.md describe the public surface (commands, flags,
 * exit codes, MCP tools, benchmark numbers). If one of those changes in code and the docs are not updated in the same commit,
 * this file fails `npm test` and CI. See the standing rule in CLAUDE.md.
 */

const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const README = read('README.md');
const SKILL = read('skills/sql-anything/SKILL.md');
const CLI_SRC = read('src/cli.ts');
const CLI = path.join(REPO, 'dist', 'src', 'cli.js');
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });

/** Rows of the markdown table that starts with the given header cell, as their first cell with backticks stripped. */
function tableFirstCells(md: string, header: string): string[] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`| ${header}`));
  assert.ok(start >= 0, `table with header "${header}" not found`);
  const cells: string[] = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) cells.push(lines[i].split('|')[1].trim().replace(/`/g, ''));
  return cells;
}

/** Flags the argument parser really accepts: every `name: { type: 'string' | 'boolean' }` in src/cli.ts. */
const PARSER_FLAGS = new Set([...CLI_SRC.matchAll(/(?:^|[\s,{])'?([a-z][a-z-]*)'?: \{ type: '(?:string|boolean)'/g)].map((m) => `--${m[1]}`));
const flagsIn = (text: string) => new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]));

describe('README <-> CLI', () => {
  const help = run('--help');

  it('--help exits 0 and prints exactly the commands in COMMANDS', () => {
    assert.equal(help.status, EXIT.OK);
    const fromHelp = [...help.stdout.matchAll(/^\s+sql-anything ([a-z]+)\b/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(fromHelp)].sort(), [...COMMANDS].sort(), 'the help text lists a command that does not exist, or omits one that does');
  });

  it('every command in COMMANDS has a handler and is not treated as unknown', () => {
    for (const cmd of COMMANDS) {
      if (cmd === 'mcp') continue; // would start the stdio server
      const r = run(cmd, '--definitely-not-a-flag');
      assert.equal(r.status, EXIT.USAGE, `${cmd}: ${r.stderr}`);
      assert.ok(!/unknown command/.test(r.stderr), `"${cmd}" is in COMMANDS but the CLI does not dispatch it`);
    }
    const bad = run('definitely-not-a-command');
    assert.equal(bad.status, EXIT.USAGE);
    assert.match(bad.stderr, /unknown command/);
  });

  it('README documents every subcommand in its CLI reference table', () => {
    const documented = tableFirstCells(README, 'Command').map((c) => c.split(' ')[0]);
    for (const cmd of COMMANDS) assert.ok(documented.includes(cmd), `README CLI table is missing \`${cmd}\``);
    for (const d of documented) assert.ok((COMMANDS as readonly string[]).includes(d), `README documents \`${d}\`, which is not a command`);
  });

  it('every flag the argument parser accepts is documented in README, and README names no flag that does not exist', () => {
    const inReadme = flagsIn(README);
    const missing = [...PARSER_FLAGS].filter((f) => !inReadme.has(f));
    assert.deepEqual(missing, [], `flags accepted by the CLI but absent from README.md: ${missing.join(' ')}`);
    const NOT_OURS = new Set(['--import', '--help']); // Node's own flag in the pipeline sketch; the help flag
    const unknown = [...inReadme].filter((f) => !PARSER_FLAGS.has(f) && !NOT_OURS.has(f));
    assert.deepEqual(unknown, [], `README mentions flags the CLI does not accept: ${unknown.join(' ')}`);
  });

  it('every flag in the --help text exists, and so do the flags in SKILL.md code spans', () => {
    const unknownInHelp = [...flagsIn(help.stdout)].filter((f) => !PARSER_FLAGS.has(f) && f !== '--help');
    assert.deepEqual(unknownInHelp, [], `--help documents flags the parser does not have: ${unknownInHelp.join(' ')}`);
    const unknownInSkill = [...flagsIn(SKILL)].filter((f) => !PARSER_FLAGS.has(f));
    assert.deepEqual(unknownInSkill, [], `SKILL.md mentions flags the CLI does not accept: ${unknownInSkill.join(' ')}`);
  });

  it('commands invoked as `sql-anything <word>` in README and SKILL.md are real subcommands', () => {
    for (const [name, text] of [['README.md', README], ['SKILL.md', SKILL]] as const) {
      for (const m of text.matchAll(/(?:npx )?sql-anything ([a-z]+)(?=[\s`<])/g)) {
        const word = m[1];
        if (['is', 'a', 'the', 'and', 'or', 'to', 'for', 'in', 'on', 'with', 'does', 'picked', 'finds', 'refuses', 'makes', 'runs', 'will', 'has', 'was', 'tells', 'writes', 'only', 'if', 'not'].includes(word)) continue;
        assert.ok((COMMANDS as readonly string[]).includes(word), `${name} runs "sql-anything ${word}", which is not a command`);
      }
    }
  });
});

describe('README <-> exit codes', () => {
  it('the exit-code table equals the EXIT constants', () => {
    const documented = tableFirstCells(README, 'Exit code').map(Number).sort();
    assert.deepEqual(documented, Object.values(EXIT).sort(), 'README exit-code table does not match src/meta.ts');
  });

  it('--help states the same codes, and SKILL.md has the same table', () => {
    const line = run('--help').stdout.split('\n').find((l) => l.startsWith('Exit codes:'));
    assert.ok(line, '--help has no "Exit codes:" line');
    for (const code of Object.values(EXIT)) {
      assert.match(line!, new RegExp(`\\b${code}\\b`), `--help does not mention exit code ${code}`);
      assert.match(SKILL, new RegExp(`\\|\\s*\`?${code}\`?\\s*\\|`), `SKILL.md exit-code table does not mention ${code}`);
    }
  });

  it('the CLI really returns them', () => {
    assert.equal(run('--help').status, EXIT.OK);
    assert.equal(run().status, EXIT.USAGE, 'no command is a usage error');
    assert.equal(run('verify').status, EXIT.USAGE, 'verify without --db');
    assert.equal(run('go', '--dry-run', '--db', 'x.db', '--', process.execPath, 'app.js').status, EXIT.OK);
  });
});

describe('README <-> MCP tools', () => {
  it('README and SKILL.md list exactly the tools the server registers', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer();
    const client = new Client({ name: 'readme-sync', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const registered = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    await server.close();
    assert.ok(registered.length >= 5);
    assert.deepEqual(tableFirstCells(README, 'MCP tool').sort(), registered, 'README MCP table does not match the registered tools');
    for (const tool of registered) assert.ok(SKILL.includes(`\`${tool}\``), `SKILL.md does not mention the MCP tool \`${tool}\``);
  });
});

describe('README links and anchors', () => {
  const slug = (h: string) => h.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
  const docs = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'skills/sql-anything/SKILL.md', 'examples/sqlite-shop/README.md', 'examples/postgres-saas/README.md', 'docs/benchmarks/conduit/RESULTS.md', 'docs/benchmarks/sqlite-shop/RESULTS.md'];

  it('every relative link and image in the docs exists on disk (no broken images or dead links on GitHub)', () => {
    const broken: string[] = [];
    for (const doc of docs) {
      const text = read(doc);
      const targets = [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).concat([...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]));
      for (const t of targets) {
        if (/^(https?:|mailto:|#)/.test(t)) continue;
        const file = path.resolve(path.dirname(path.join(REPO, doc)), decodeURI(t.split('#')[0]));
        if (!fs.existsSync(file)) broken.push(`${doc} -> ${t}`);
      }
    }
    assert.deepEqual(broken, []);
  });

  it('in-page anchors in README.md point at real headings', () => {
    const heads = new Set([...README.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
    const bad = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !heads.has(a));
    assert.deepEqual(bad, []);
  });
});

describe('README numbers come from benchmark artifacts', () => {
  const dir = path.join(REPO, 'docs', 'benchmarks');
  const artifactFiles: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (/\.(md|svg)$/.test(e.name)) artifactFiles.push(path.join(d, e.name));
    }
  };
  walk(dir);
  const artifacts = artifactFiles
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/×/g, 'x')
    .replace(/→/g, '->');

  it('every speedup (12.3x) quoted in README appears in a file under docs/benchmarks/ (or is the gate threshold)', () => {
    const quoted = new Set([...README.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)x(?![\w])/g)].map((m) => `${m[1]}x`));
    const missing = [...quoted].filter((q) => !artifacts.includes(q));
    assert.deepEqual(missing, [], `README quotes speedups that no benchmark artifact contains: ${missing.join(' ')}`);
  });

  it('every "N/N replayed" and "N/N runs" count quoted in README appears in an artifact', () => {
    const quoted = new Set([...README.matchAll(/(\d+\/\d+) (replayed|runs)/g)].map((m) => `${m[1]} ${m[2]}`));
    assert.ok(quoted.size >= 2);
    const missing = [...quoted].filter((q) => !artifacts.includes(q));
    assert.deepEqual(missing, [], `README quotes counts that no benchmark artifact contains: ${missing.join(' ')}`);
  });

  it('the hero card exists, is the artifact the caption describes, and every card is referenced from a RESULTS.md', () => {
    const hero = /!\[[^\]]*\]\((docs\/benchmarks\/[^)]+\.svg)\)/.exec(README)?.[1];
    assert.ok(hero, 'README has no benchmark card image');
    const svg = read(hero!);
    assert.match(svg, /replayed · row parity/);
    assert.ok(README.includes(svg.match(/(\d+\/\d+) replayed · row parity/)![0]), 'the hero caption must quote the card badge verbatim');
    for (const f of artifactFiles.filter((x) => x.endsWith('.svg'))) {
      const name = path.basename(f);
      assert.ok(artifactFiles.some((r) => r.endsWith('.md') && fs.readFileSync(r, 'utf8').includes(name)), `${name} is not referenced by any RESULTS.md`);
    }
  });
});

describe('the documentation rule itself', () => {
  it('CLAUDE.md carries the standing rule naming all three files', () => {
    const claude = read('CLAUDE.md');
    for (const f of ['README.md', 'skills/sql-anything/SKILL.md', 'CHANGELOG.md']) assert.ok(claude.includes(f), `CLAUDE.md does not name ${f}`);
  });

  it('CHANGELOG.md has an entry for the version in package.json', () => {
    const v = JSON.parse(read('package.json')).version.replace(/-.*$/, '');
    assert.ok(read('CHANGELOG.md').includes(`## [${v}]`), `CHANGELOG.md has no "## [${v}]" section`);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { capture } from '../../src/capture.js';
import { REPO, FIXTURES, freePort, seedSqlite, tmpDir } from '../helpers.js';

let root: string;
let dbFile: string;
let traceDir: string;
let client: Client;

const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};

before(async () => {
  root = tmpDir();
  dbFile = path.join(root, 'app.db');
  await seedSqlite(dbFile);
  traceDir = path.join(root, 'run');
  const port = await freePort();
  await capture({ cmd: [process.execPath, path.join(FIXTURES, 'sqlite-app.js')], traceDir, env: { SQL_ANYTHING_DB_URL: dbFile, PORT: String(port) }, hits: [`http://127.0.0.1:${port}/`], hitRepeat: 3, quiet: true });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, 'dist', 'src', 'cli.js'), 'mcp'], cwd: root, stderr: 'ignore' }));
});
after(async () => {
  await client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP server (stdio)', () => {
  it('lists the five tools with descriptions and honest annotations', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['fix', 'report', 'scan', 'verify', 'verify_workload']);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 80, `${t.name} has a real description`);
      assert.equal(t.annotations?.destructiveHint, false);
    }
    assert.match(tools.find((t) => t.name === 'verify')!.description!, /Never claim a fix is verified unless verdict is PASS/);
  });

  it('scan analyzes a trace and returns findings with file:line and no parameter values', async () => {
    const r = await call('scan', { trace: traceDir, db: dbFile });
    assert.equal(r.isError, false);
    assert.equal(r.body.exitCode, 0);
    const n1 = r.body.findings.find((f: any) => f.kind === 'n+1');
    assert.ok(n1, 'N+1 found over MCP');
    assert.match(n1.callsite, /sqlite-app\.js:\d+:\d+$/);
    assert.ok(!JSON.stringify(r.body).includes('params'), 'no parameter values leave the server');
  });

  it('verify PASSes a real index and REJECTs a wrong rewrite, with the failing gate in the payload', async () => {
    const ok = await call('verify', { db: dbFile, trace: traceDir, migration: 'create index idx_orders_customer on orders(customer_id)', target: ['F1'] });
    assert.equal(ok.body.verdict, 'PASS', JSON.stringify(ok.body.gates));
    assert.equal(ok.body.exitCode, 0);
    const scan = await call('scan', { trace: traceDir });
    const fp = scan.body.findings.find((f: any) => f.kind === 'n+1').fingerprint;
    const bad = await call('verify', { db: dbFile, trace: traceDir, rewrites: { [fp]: "select count(*) as c from orders where customer_id = ? and status = 'new'" } });
    assert.equal(bad.body.verdict, 'REJECT');
    assert.equal(bad.body.exitCode, 2);
    assert.equal(bad.body.gates.find((g: any) => g.name === 'parity').status, 'fail');
  });

  it('fix (deterministic) then report writes the PR block and an SVG card', async () => {
    const f = await call('fix', { finding: 'F1', db: dbFile, trace: traceDir });
    assert.equal(f.body.status, 'verified', JSON.stringify(f.body));
    assert.match(f.body.migration, /CREATE INDEX/);
    assert.match(f.body.down, /DROP INDEX/);
    const r = await call('report', { trace: traceDir, label: 'synthetic demo' });
    assert.ok(r.body.files.some((x: string) => x.endsWith('.svg')));
    assert.match(r.body.markdown, /CREATE INDEX/);
  });

  it('errors are structured, not crashes', async () => {
    const r = await call('fix', { finding: 'F99', db: dbFile, trace: traceDir });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /no finding "F99"/);
    const v = await call('verify', { db: path.join(root, 'missing.db'), trace: traceDir, migration: 'select 1' });
    assert.equal(v.isError, true);
    assert.match(v.body.error, /sqlite database not found/);
  });
});

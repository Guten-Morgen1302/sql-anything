/* eslint-disable @typescript-eslint/no-explicit-any */
// A scripted stand-in for `claude -p`: reads the prompt on stdin, edits files in cwd according to SA_FAKE_MODE.
import fs from 'node:fs';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const mode = process.env.SA_FAKE_MODE ?? 'noop';
const logDir = process.env.SA_FAKE_LOG;
if (logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const n = fs.readdirSync(logDir).filter((f) => f.startsWith('prompt-')).length + 1;
  fs.writeFileSync(path.join(logDir, `prompt-${n}.txt`), prompt);
  fs.writeFileSync(path.join(logDir, `env-${n}.json`), JSON.stringify(Object.keys(process.env)));
  fs.writeFileSync(path.join(logDir, `cwd-${n}.txt`), process.cwd());
}
const setVariant = (v: string) => {
  const f = path.join(process.cwd(), 'server.mjs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/const VARIANT: string = '\w+'|const VARIANT = '\w+'/, `const VARIANT = '${v}'`));
};
const rejectedBefore = /REJECTED/.test(prompt);

switch (mode) {
  case 'fix-n1':
    setVariant('FIXED');
    break;
  case 'broken-then-fixed':
    setVariant(rejectedBefore ? 'FIXED' : 'BROKEN');
    break;
  case 'always-broken':
    setVariant('BROKEN');
    break;
  case 'proposal-index':
    fs.mkdirSync('.sql-anything', { recursive: true });
    fs.writeFileSync('.sql-anything/proposal.json', JSON.stringify({ migration: 'CREATE INDEX agent_idx_orders_customer ON orders (customer_id)' }));
    break;
  case 'proposal-garbage':
    fs.mkdirSync('.sql-anything', { recursive: true });
    fs.writeFileSync('.sql-anything/proposal.json', '{not json');
    break;
  case 'crash':
    console.error('boom: model unavailable');
    process.exit(7);
    break;
  case 'noop':
  default:
    break;
}

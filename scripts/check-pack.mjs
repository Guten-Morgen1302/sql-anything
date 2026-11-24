// Fails if the npm tarball would contain anything that should never ship: planning docs, spikes, tests, env files, traces.
// Run by CI and by `npm run check:pack`. Not itself part of the published package.
import { spawnSync } from 'node:child_process';

// Under `npm run`, npm_execpath is npm's own script: run it with node, no shell needed on any OS.
const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
const r = process.env.npm_execpath
  ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8' })
  : spawnSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(2);
}
const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);

const ALLOWED = [/^dist\/src\//, /^examples\//, /^skills\//, /^README\.md$/, /^LICENSE$/, /^package\.json$/, /^CHANGELOG\.md$/];
const FORBIDDEN = [/(^|\/)\.env/, /^docs\//, /^spikes\//, /^test\//, /^dist\/test\//, /(^|\/)\.sql-anything\//, /(^|\/)\.gstack\//, /(^|\/)trace\.[^/]*\.jsonl$/, /\.(db|sqlite|log|tgz)$/, /(^|\/)node_modules\//, /^CLAUDE\.md$/, /^scripts\//, /^\.github\//];

const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
const unexpected = files.filter((f) => !ALLOWED.some((re) => re.test(f)) && !bad.includes(f));
if (bad.length || unexpected.length) {
  if (bad.length) console.error('FORBIDDEN files in the tarball:\n  ' + bad.join('\n  '));
  if (unexpected.length) console.error('Files outside the allow-list (add them to ALLOWED on purpose, or remove them):\n  ' + unexpected.join('\n  '));
  process.exit(1);
}
console.log(`pack ok: ${files.length} files, none forbidden`);

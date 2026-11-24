// One-command setup: generate a local password (once), start Postgres with Docker Compose, seed the data.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { ENV_FILE, databaseUrl, readPassword } from './db.mjs';
import { seed } from './seed.mjs';

if (!readPassword()) {
  fs.writeFileSync(ENV_FILE, `SAAS_DB_PASSWORD=${randomBytes(16).toString('hex')}\n`, { mode: 0o600 });
  console.log('generated a random local database password into .env (git-ignored)');
}
// no shell: `docker` is a real executable on every platform, and a shell would only add quoting problems
const up = spawnSync('docker', ['compose', 'up', '-d', '--wait'], { stdio: 'inherit' });
if (up.status !== 0) {
  console.error('docker compose failed. Is Docker running? You can also seed any Postgres you already have: DATABASE_URL=postgres://... node seed.mjs');
  process.exit(up.status ?? 1);
}
const t0 = Date.now();
const counts = await seed(databaseUrl());
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`, counts);
console.log('\nstart the API:  PORT=3000 npm start');
console.log('database URL:   node db.mjs');

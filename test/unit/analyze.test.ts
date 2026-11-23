import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyze } from '../../src/scan/analyze.js';
import { rec } from '../helpers.js';

describe('N+1 detector', () => {
  const base = { db: 'pg' as const, dur_us: 800, frame: '/app/helpers.js:16:26', frame_exact: true };

  it('detects a loop whose values are bind params', async () => {
    const records = Array.from({ length: 8 }, (_, i) => rec('select count(*) from favorites where article_id = $1', [i + 1], { ...base, req: 1 }));
    const r = await analyze(records, 1);
    assert.equal(r.findings.find((f) => f.kind === 'n+1')?.n1?.maxPerRequest, 8);
  });

  it('detects a loop whose values are INLINED in the SQL text with no params (Sequelize, found on a real app)', async () => {
    const records = Array.from({ length: 50 }, (_, i) => rec(`select count("User"."id") from "Users" as "User" inner join "Favorites" on "User"."id" = "Favorites"."userId" and "Favorites"."articleId" = ${120000 - i}`, [], { ...base, req: 1 }));
    delete (records[0] as { params?: unknown }).params;
    const r = await analyze(records, 1);
    const n1 = r.findings.find((f) => f.kind === 'n+1');
    assert.ok(n1, JSON.stringify(r.findings.map((f) => f.kind)));
    assert.equal(n1!.n1!.maxPerRequest, 50);
    assert.equal(n1!.callsite, '/app/helpers.js:16:26');
  });

  it('the same statement with the same values repeated is not "N+1 with a varying key"', async () => {
    const records = Array.from({ length: 10 }, () => rec('select 1 from t where id = $1', [7], { ...base, req: 1 }));
    const r = await analyze(records, 1);
    assert.ok(!r.findings.some((f) => f.kind === 'n+1'));
  });

  it('fewer repeats than the threshold are not reported', async () => {
    const records = Array.from({ length: 4 }, (_, i) => rec('select 1 from t where id = $1', [i], { ...base, req: 1 }));
    assert.ok(!(await analyze(records, 1)).findings.some((f) => f.kind === 'n+1'));
  });

  it('separate requests are separate buckets: 3 calls in each of 3 requests is not an N+1 of 9', async () => {
    const records = [1, 2, 3].flatMap((req) => [1, 2, 3].map((i) => rec('select 1 from t where id = $1', [i], { ...base, req })));
    assert.ok(!(await analyze(records, 1)).findings.some((f) => f.kind === 'n+1'));
  });
});

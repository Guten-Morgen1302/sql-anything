/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Conn } from '../db/conn.js';

export interface SeqScan {
  table: string;
  /** fraction of scanned rows thrown away by the filter, 0..1 */
  rejected: number;
  scannedRows: number;
}

export interface PlanFacts {
  engine: 'sqlite' | 'pg';
  selectiveSeqScans: SeqScan[];
  correlatedSubquery: boolean;
  execMs?: number;
  summary: string;
}

const MIN_ROWS = 1000;
const MIN_REJECTED = 0.9;

/**
 * Plan facts for one statement. Always run against a shadow clone: EXPLAIN ANALYZE really executes the statement.
 * A sequential scan is only reported when it throws most of its rows away. A planner-correct scan of a small
 * or fully-consumed table is not a finding.
 */
export async function explainOn(conn: Conn, sql: string, params: unknown[]): Promise<PlanFacts> {
  return conn.kind === 'pg' ? explainPg(conn, sql, params) : explainSqlite(conn, sql, params);
}

async function explainPg(conn: Conn, sql: string, params: unknown[]): Promise<PlanFacts> {
  await conn.exec('BEGIN');
  try {
    const r = await conn.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const doc = JSON.parse(String(r.rows[0][0]))[0];
    const scans: SeqScan[] = [];
    let correlated = false;
    const types: string[] = [];
    const walk = (n: any) => {
      types.push(n['Node Type'] + (n['Relation Name'] ? ` on ${n['Relation Name']}` : ''));
      const loops = Number(n['Actual Loops'] ?? 1);
      if (n['Node Type'] === 'Seq Scan') {
        const removed = Number(n['Rows Removed by Filter'] ?? 0) * loops;
        const kept = Number(n['Actual Rows'] ?? 0) * loops;
        const total = removed + kept;
        if (total >= MIN_ROWS && removed / total >= MIN_REJECTED) scans.push({ table: n['Relation Name'], rejected: removed / total, scannedRows: total });
      }
      if (n['Parent Relationship'] === 'SubPlan' && loops >= 100) correlated = true;
      for (const c of n.Plans ?? []) walk(c);
    };
    walk(doc.Plan);
    return { engine: 'pg', selectiveSeqScans: scans, correlatedSubquery: correlated, execMs: Number(doc['Execution Time']), summary: types.join(' > ') };
  } finally {
    await conn.exec('ROLLBACK').catch(() => {});
  }
}

async function explainSqlite(conn: Conn, sql: string, params: unknown[]): Promise<PlanFacts> {
  const r = await conn.query(`EXPLAIN QUERY PLAN ${sql}`, params);
  const details = r.rows.map((row) => String(row[3]));
  const scans: SeqScan[] = [];
  const hasFilter = /\b(where|join)\b/i.test(sql);
  let rowsOut: number | null = null;
  for (const d of details) {
    const m = /^SCAN (?:TABLE )?("[^"]+"|\w+)(?: AS \w+)?$/.exec(d); // no USING clause: a full table scan
    if (!m || !hasFilter) continue;
    const table = m[1].replace(/^"|"$/g, '');
    const total = Number((await conn.query(`SELECT count(*) FROM "${table.replace(/"/g, '""')}"`)).rows[0][0]);
    if (total < MIN_ROWS) continue;
    if (rowsOut === null) rowsOut = (await conn.query(sql, params)).rows.length;
    const rejected = 1 - Math.min(rowsOut, total) / total;
    if (rejected >= MIN_REJECTED) scans.push({ table, rejected, scannedRows: total });
  }
  return {
    engine: 'sqlite',
    selectiveSeqScans: scans,
    correlatedSubquery: details.some((d) => /^CORRELATED/.test(d)),
    summary: details.join(' > '),
  };
}

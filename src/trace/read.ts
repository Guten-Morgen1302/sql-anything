import fs from 'node:fs';
import path from 'node:path';
import type { ConnRecord, HookLoadedRecord, TraceRecord } from './types.js';

export interface TraceData {
  records: TraceRecord[];
  hooks: HookLoadedRecord[];
  conns: ConnRecord[];
  badLines: number;
}

/** Read every trace.*.jsonl in a directory, merged in call order. Tolerates a torn final line. */
export function readTrace(dir: string): TraceData {
  const records: TraceRecord[] = [];
  const hooks: HookLoadedRecord[] = [];
  const conns: ConnRecord[] = [];
  let badLines = 0;
  if (!fs.existsSync(dir)) return { records, hooks, conns, badLines };
  for (const f of fs.readdirSync(dir)) {
    if (!/^trace\..*\.jsonl$/.test(f)) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'q') records.push(o as TraceRecord);
        else if (o.type === 'hook-loaded') hooks.push(o as HookLoadedRecord);
        else if (o.type === 'conn') conns.push(o as ConnRecord);
      } catch {
        badLines++;
      }
    }
  }
  records.sort((a, b) => a.t - b.t || a.pid - b.pid || a.seq - b.seq);
  return { records, hooks, conns, badLines };
}

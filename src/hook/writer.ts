import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';

/**
 * Buffered, append-only JSONL writer, one file per pid+thread (no cross-process write races).
 * Sync writes cost ~1ms each in the Day-1 spike, so we batch. Never throws into the host app.
 */
export class TraceWriter {
  private buf: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private dead = false;
  readonly file: string;
  readonly sync: boolean;

  constructor() {
    const dir = process.env.SQL_ANYTHING_TRACE_DIR || path.join(os.tmpdir(), 'sql-anything-trace');
    this.sync = process.env.SQL_ANYTHING_SYNC === '1';
    this.file = path.join(dir, `trace.${process.pid}.${threadId}.jsonl`);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      this.dead = true;
    }
    process.on('exit', () => this.flushSync());
  }

  write(o: unknown): void {
    if (this.dead) return;
    try {
      const line = JSON.stringify(o) + String.fromCharCode(10);
      if (this.sync) {
        fs.appendFileSync(this.file, line);
        return;
      }
      this.buf.push(line);
      if (this.buf.length >= 2000) this.flushAsync();
      else if (!this.timer) this.timer = setTimeout(() => this.flushAsync(), 200).unref();
    } catch {
      this.dead = true; // tracing must never break the app
    }
  }

  private flushAsync(): void {
    this.timer = null;
    if (!this.buf.length) return;
    const data = this.buf.join('');
    this.buf = [];
    fs.appendFile(this.file, data, () => {});
  }

  flushSync(): void {
    try {
      if (this.buf.length) fs.appendFileSync(this.file, this.buf.join(''));
      this.buf = [];
    } catch {
      /* ignore */
    }
  }
}

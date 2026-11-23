import type { CheckResult } from '../verify/check.js';
import type { VerifyResult } from '../verify/verify.js';

export interface Attempt {
  n: number;
  via: 'index-candidate' | 'user-migration' | 'agent';
  description: string;
  outcome: 'verified' | 'rejected' | 'unverifiable' | 'no-change' | 'error';
  /** human-readable failed gates, fed back to the agent on the next attempt */
  failed: string[];
}

/** What `report` reads. No parameter values, no absolute paths. */
export interface FixRecord {
  findingId: string;
  fingerprint: string;
  kind: string;
  via: 'index-candidate' | 'user-migration' | 'agent';
  callsite: string | null;
  sql: string;
  migrationSql?: string;
  downSql?: string;
  rewrites?: Record<string, string>;
  /** git patch file, relative to the fix directory */
  patchFile?: string;
  changedFiles?: string[];
  verify?: VerifyResult;
  check?: CheckResult;
  attempts: number;
  createdAt: string;
}

export interface FixResult {
  status: 'verified' | 'rejected' | 'unverifiable' | 'no-fix';
  findingId: string;
  attempts: Attempt[];
  dir?: string;
  record?: FixRecord;
  message: string;
}

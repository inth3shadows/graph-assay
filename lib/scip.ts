// Read a SCIP index: a binary .scip (decoded with `scip print --json`) or an already-decoded .json
// (what the hermetic self-tests freeze, so they need no scip binary).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { config } from './config.ts';

export function loadScip(file) {
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = spawnSync(config.scipBin, ['print', '--json', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`scip print failed: ${r.error ? `${r.error.message} (is the scip CLI at ${config.scipBin}? tools/setup-oracle-tools.sh installs it)` : r.signal ? `killed by ${r.signal}` : (r.stderr ?? '').slice(-400)}`);
  return JSON.parse(r.stdout);
}

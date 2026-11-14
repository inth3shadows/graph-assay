// The oracle's rules for `run.ts --mutate`: every `on('<rule>')` in the modules oracle.ts imports,
// followed through relative `.ts` imports. Other oracle/ scripts (site.ts, baseline.ts, ts-cover.ts)
// are never read, so an `on('x')` there cannot register a rule that the oracle does not have.
import * as fs from 'node:fs';
import * as path from 'node:path';

export function oracleRules(entry: string): string[] {
  const seen = new Set<string>(); const rules = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bon\('([^']+)'\)/g)) rules.add(m[1]);
    for (const m of text.matchAll(/^import\s[^;]*?from\s+'(\.\/[^']+\.ts)'/gm)) visit(path.join(path.dirname(file), m[1]));
  };
  visit(path.resolve(entry));
  return [...rules].sort();
}

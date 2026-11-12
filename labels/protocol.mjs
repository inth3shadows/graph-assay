#!/usr/bin/env node
// The pinned labelling protocol (SPEC §9 oracle-noise sample): labels/protocol.json names each
// labeller's model, effort and runtime, the labelling dates, the prompt template's hash, the
// qualification items and every committed labelling file with its sha256. The protocol's identity
// is the sha256 of protocol.json itself, so it pins every file it lists. Tables show it.
//
//   node labels/protocol.mjs            verify (exit 1 on any mismatch) and print the summary
//   node labels/protocol.mjs --update   rewrite the `files` hashes and the prompt hash in place
//                                       (only after a deliberate change; it is a new protocol)
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LABELLERS } from './labellers.mjs';
import { correct, question } from './questions.mjs';
import { wilson } from './score.mjs';
import { isMain } from '../lib/main.mjs';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROTOCOL = path.join(qa, 'labels', 'protocol.json');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** The prompt for a fixed item with no repository: changes exactly when the template does. */
export function promptTemplateSha256() {
  const { prompt } = question({ id: 'protocol', site: { file: 'site.ext', line: 1, name: 'NAME' }, candidates: [{ file: 'c.ext', line: 1 }] }, '/nonexistent');
  return sha(prompt);
}

/** Every committed labelling file the protocol pins: the qualification set and each sample. */
function pinnedFiles() {
  const dirs = ['labels/qualification', ...fs.readdirSync(path.join(qa, 'labels/data')).sort().map((d) => `labels/data/${d}`)];
  return dirs.flatMap((d) => fs.readdirSync(path.join(qa, d)).sort().map((f) => `${d}/${f}`));
}

/** Check the protocol against the repository; {sha256, problems, protocol, qualification}. */
export function loadProtocol(file = PROTOCOL) {
  const text = fs.readFileSync(file, 'utf8');
  const p = JSON.parse(text);
  const problems = [];
  if (p.prompt.templateSha256 !== promptTemplateSha256()) problems.push(`prompt template changed: ${promptTemplateSha256()} != pinned ${p.prompt.templateSha256}`);
  for (const [name, l] of Object.entries(p.labellers)) {
    const live = LABELLERS[name];
    if (!live) problems.push(`labeller ${name} is not in labels/labellers.mjs`);
    else if (live.model !== l.model || live.effort !== l.effort) problems.push(`labeller ${name}: labellers.mjs has ${live.model}/${live.effort}, protocol ${l.model}/${l.effort}`);
  }
  const listed = new Set(Object.keys(p.files));
  for (const f of pinnedFiles()) if (!listed.has(f)) problems.push(`${f} is not pinned`);
  for (const [f, h] of Object.entries(p.files)) {
    const abs = path.join(qa, f);
    if (!fs.existsSync(abs)) problems.push(`${f} is pinned but missing`);
    else if (sha(fs.readFileSync(abs)) !== h) problems.push(`${f} differs from the pinned sha256`);
  }
  return { sha256: sha(text), problems, protocol: p, qualification: qualification(p) };
}

/** Each labeller's accuracy on the known-answer items, as labels/score.mjs counts it. */
function qualification(p) {
  const dir = path.join(qa, p.qualification.dir);
  const items = new Map(readJsonl(path.join(dir, 'items.jsonl')).map((i) => [i.id, i]));
  const out = {};
  for (const name of Object.keys(p.labellers)) {
    const f = path.join(dir, `${name}.jsonl`);
    if (!fs.existsSync(f)) continue;
    const clean = readJsonl(f).filter((r) => r.ok && items.has(r.id) && !(r.served_by ?? []).some((s) => s !== (r.deployment ?? r.model)));
    const right = clean.filter((r) => correct(r.answer, items.get(r.id).truth)).length;
    out[name] = { correct: right, answered: clean.length, items: items.size, ci: wilson(right, clean.length) };
  }
  return out;
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--update')) {
    const p = JSON.parse(fs.readFileSync(PROTOCOL, 'utf8'));
    p.prompt.templateSha256 = promptTemplateSha256();
    p.files = Object.fromEntries(pinnedFiles().map((f) => [f, sha(fs.readFileSync(path.join(qa, f)))]));
    fs.writeFileSync(PROTOCOL, `${JSON.stringify(p, null, 1)}\n`);
  }
  const { sha256, problems, protocol, qualification: q } = loadProtocol();
  console.log(`labelling protocol sha256 ${sha256} (${Object.keys(protocol.files).length} files pinned)`);
  for (const [name, l] of Object.entries(protocol.labellers)) {
    const s = q[name];
    console.log(`  ${name.padEnd(8)} ${l.model} (${l.role}); qualification ${s ? `${s.correct}/${s.answered}` : '-'}`);
  }
  for (const x of problems) console.log(`PROBLEM ${x}`);
  process.exit(problems.length ? 1 : 0);
}

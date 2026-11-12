#!/usr/bin/env node
// The hand-written snapshot validator must enforce what schema/snapshot.v1.json requires: delete any
// required field from a valid snapshot and validateSnapshot must report it. Part of `graph-assay check`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codegraph from './subjects/codegraph.mjs';
import { validateSnapshot } from './snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'schema', 'snapshot.v1.json'), 'utf8'));
const valid = JSON.parse(JSON.stringify(codegraph.snapshot(path.join(here, 'test', 'adapters', 'codegraph'))));
let n = 0; const missed = [];
const item = (v) => (v.items?.$ref ? (schema.$defs ?? schema.definitions)[v.items.$ref.split('/').pop()] : v.items);
assert.deepEqual(validateSnapshot(valid), [], 'the base snapshot must be valid');
for (const key of schema.required) {
  n++; const s = structuredClone(valid); delete s[key];
  if (!validateSnapshot(s).length) missed.push(key);
}
for (const [key, v] of Object.entries(schema.properties)) {
  const req = v.type === 'array' ? item(v)?.required : v.required;
  for (const field of req ?? []) {
    n++; const s = structuredClone(valid);
    if (v.type === 'array') { if (!s[key].length) continue; delete s[key][0][field]; } else delete s[key][field];
    if (!validateSnapshot(s).length) missed.push(`${key}${v.type === 'array' ? '[]' : ''}.${field}`);
  }
}
if (missed.length) { console.error(`FAIL validator accepts a snapshot missing: ${missed.join(', ')}`); process.exitCode = 1; }
else console.log(`${n}/${n} schema-required fields enforced by the validator`);

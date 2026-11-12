#!/usr/bin/env node
// Contract: SPEC_VERSION matches SPEC.md. A declared spec ("# ... (SPEC vN.M)") is the version
// results record; while the title says "draft", results stay labelled SPEC v0 (SPEC §12).
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SPEC_VERSION } from './spec.ts';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const title = fs.readFileSync(path.join(qa, 'SPEC.md'), 'utf8').split('\n')[0];
const m = title.match(/\((SPEC v\d+(?:\.\d+)?)(, draft)?\)\s*$/);
assert.ok(m, `SPEC.md title has no "(SPEC vN.M[, draft])": ${title}`);
const [, declared, draft] = m;
if (draft && declared !== 'SPEC v0') assert.equal(SPEC_VERSION, 'SPEC v0', `${declared} is a draft: results must stay SPEC v0`);
else assert.equal(SPEC_VERSION, declared, `SPEC.md declares ${declared}; lib/spec.ts says ${SPEC_VERSION}`);
console.log(`1/1 spec-version checks (${SPEC_VERSION}; SPEC.md: ${declared}${draft ?? ''})`);

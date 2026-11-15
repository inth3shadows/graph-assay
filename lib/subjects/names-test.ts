#!/usr/bin/env node
// The data-only subject list (names.ts) agrees with the adapter registry and with run.sh's work dirs.
import assert from 'node:assert/strict';
import { SUBJECTS } from './index.ts';
import { SUBJECT_NAMES, TAG, workSuffix, baseWorkDir } from './names.ts';

assert.deepEqual(SUBJECT_NAMES, Object.keys(SUBJECTS), 'names.ts and index.ts list different subjects');
assert.deepEqual(Object.keys(TAG), SUBJECT_NAMES, 'every subject needs a tag');
assert.equal(new Set(Object.values(TAG)).size, SUBJECT_NAMES.length, 'tags must be unique');
assert.equal(workSuffix('codegraph'), '');
assert.equal(workSuffix('code-review-graph'), '-code-review-graph');
for (const s of SUBJECT_NAMES) assert.equal(baseWorkDir(`/w/w-pub-ky${workSuffix(s)}`), '/w/w-pub-ky', s);
assert.equal(baseWorkDir('/w/w-pub-graph'), '/w/w-pub-graph');
console.log(`ok    names: ${SUBJECT_NAMES.length} subjects agree with the registry`);

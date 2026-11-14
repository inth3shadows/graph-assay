#!/usr/bin/env node
// No committed text file may carry a local home path or a credential. Labelling answers are the main
// risk (a labeller steered by a prompt injection could copy either into its answer; SECURITY.md), and
// frozen tool outputs are the next (an export records absolute paths). Part of `graph-assay check`.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEAKS: [string, RegExp][] = [
  ['home path', /(?:\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\\\?Users\\\\?[A-Za-z0-9._-]+|\/root\/)/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API key', /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,})\b/],
];
export const leaksIn = (text) => LEAKS.filter(([, re]) => re.test(text)).map(([name]) => name);

let n = 0;
const check = (name, ok, detail = '') => { n++; if (!ok) { console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`); process.exitCode = 1; } };

// The scanner itself.
check('scan: home path', leaksIn('see /home/alice/.codex/auth.json').includes('home path'));
check('scan: macOS path', leaksIn('{"evidence":"/Users/bob/src/x.ts:3"}').includes('home path'));
check('scan: key', leaksIn('-----BEGIN OPENSSH PRIVATE KEY-----').includes('private key'));
check('scan: token', leaksIn(`token ghp_${'a'.repeat(36)}`).includes('GitHub token'));
check('scan: clean answer', leaksIn('{"choice":"B","evidence":"src/a.ts:12 calls b()"}').length === 0);

// Every committed labelling file.
const self = path.relative(qa, fileURLToPath(import.meta.url)).split(path.sep).join('/');
const files = (spawnSync('git', ['ls-files'], { cwd: qa, encoding: 'utf8' }).stdout ?? '').split('\n').filter((f) => f && f !== self);
check('labelling files are tracked', files.some((f) => f.startsWith('labels/data/')));
for (const f of files) {
  const text = fs.readFileSync(path.join(qa, f), 'utf8');
  if (text.includes('\u0000')) continue; // binary (the frozen codegraph DB is checked by its own golden test)
  const found = leaksIn(text);
  check(`no leak in ${f}`, !found.length, found.join(', '));
}
if (!process.exitCode) console.log(`${n}/${n} committed-file leak checks`);

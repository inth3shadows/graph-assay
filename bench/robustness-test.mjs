#!/usr/bin/env node
// T3 accounting, shared transformations and actual runner/table CLIs, without subject binaries.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarizeRobustness, compareChallenges, robustnessMarkdown } from './robustness.mjs';
import { applyRelation } from '../metamorphic/relations.mjs';
import { ADAPTER_SHARED } from '../lib/provenance.mjs';
import { SPEC_VERSION } from '../lib/spec.mjs';

const qa = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-t3-'));
let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok    ${name}`); };
const hash = 'a'.repeat(64); const other = 'b'.repeat(64);
const row = (extra = {}) => ({ seed: 'seed', relation: 'decoy', subject: 'codegraph', adapterSha256: hash, challengeSha256: hash, diffs: { LOST: [], GAINED: [] }, ...extra });
const write = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const env = { ...process.env, XDG_CONFIG_HOME: tmp, XDG_CACHE_HOME: tmp, NODE_NO_WARNINGS: '1' };
const run = (script, args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
try {
  check('missing and empty T3 are NOT RUN, never a passing rate', () => {
    for (const data of [null, []]) { const out = summarizeRobustness(data, 'codegraph'); assert.equal(out.status, 'NOT RUN'); assert.equal(out.relations.decoy.passRate, null); }
  });
  check('errors stay in eligible denominator; changed/N/A/unknown remain distinct', () => {
    const out = summarizeRobustness([row(), row({ seed: 'changed', diffs: { LOST: ['x'] } }), row({ seed: 'error', error: 'index failure', diffs: undefined }),
      row({ seed: 'unsupported', notApplicable: true, reason: 'no names' }), row({ seed: 'legacy', challengeSha256: undefined })], 'codegraph').relations.decoy;
    assert.equal(out.total, 5); assert.equal(out.eligible, 3); assert.equal(out.clean, 1); assert.equal(out.changed, 1); assert.equal(out.errors, 1);
    assert.equal(out.notApplicable, 1); assert.equal(out.unverified, 1); assert.equal(out.passRate, 1/3);
  });
  check('legacy empty decoys are N/A, not clean', () => {
    const out = summarizeRobustness([row({ decoys: 0, challengeSha256: undefined })], 'codegraph').relations.decoy;
    assert.equal(out.clean, 0); assert.equal(out.notApplicable, 1); assert.equal(out.eligible, 0);
  });
  check('repeat distinguishes raw-identical and graph-only; no invented raw identity', () => {
    const out = summarizeRobustness([row({ seed: 'raw', relation: 'repeat', byteIdentical: true }), row({ seed: 'graph', relation: 'repeat', byteIdentical: false }), row({ seed: 'unknown', relation: 'repeat' })], 'codegraph').relations.repeat;
    assert.equal(out.clean, 3); assert.equal(out.byteIdentical, 1); assert.equal(out.graphOnly, 1); assert.equal(out.rawUnknown, 1);
  });
  check('malformed evidence, wrong subjects, duplicate challenges and contradictory raw results fail', () => {
    for (const data of [{}, [null], [row({ diffs: undefined })], [row({ diffs: { LOST: 1 } })], [row({ relation: 'bogus' })], [row({ subject: 'other' })],
      [row(), row()], [row({ adapterSha256: 'bad' })], [row({ challengeSha256: 'bad' })], [row({ notApplicable: 'yes' })], [row({ error: {} })], [row({ error: false })], [row({ error: 0 })], [row({ error: '' })], [row({ error: null })], [row({ challengeSha256: undefined, byteIdentical: true, diffs: { LOST: ['x'] } })], [row({ notApplicable: true, reason: 'x', diffs: [] })],
      [row({ notApplicable: true, reason: 'empty', diffs: { LOST: ['x'] } })], [row({ relation: 'repeat', byteIdentical: true, diffs: { LOST: ['x'] } })]]) assert.throws(() => summarizeRobustness(data, 'codegraph'));
  });
  check('legacy setup errors remain visible rather than disappearing from all relations', () => {
    const out = summarizeRobustness([{ seed: 'bad', relation: '-', error: 'index' }], 'codegraph');
    assert.equal(out.relations.setup.errors, 1); assert.equal(out.relations.setup.passRate, 0); assert.equal(out.relations.repeat.passRate, null);assert.equal(out.complete,false);
  });
  check('comparison distinguishes mismatched, unknown and unpaired; nulls cannot match', () => {
    const a = summarizeRobustness([row(), row({ seed: 'unknown', challengeSha256: null }), row({ seed: 'alone' })], 'codegraph');
    const b = summarizeRobustness([row({ challengeSha256: other }), row({ seed: 'unknown', challengeSha256: null })], 'codegraph');
    const cmp = compareChallenges(a,b); assert.equal(cmp.matched.length, 0); assert.equal(cmp.mismatched.length, 1); assert.equal(cmp.unknown.length, 1); assert.equal(cmp.unpaired.length, 1);
    assert.match(robustnessMarkdown({ codegraph: a }, cmp).join('\n'), /unverified/);
  });
  const seed = path.join(tmp, 'seed');
  write(path.join(seed, 'main.py'), 'from __future__ import annotations\nclass Widget:\n    def run(self): return compute()\ndef compute(): return 1\nWidget().run()\n');
  write(path.join(seed, 'lib.ts'), 'export class Box { run() { return compute(); } }\nfunction compute() {}\nnew Box().run();\nconst $okay = () => 1; $okay();\n');
  check('shared decoys and fingerprints depend on source, not install path or subject output', () => {
    const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b'); fs.cpSync(seed,a,{recursive:true}); fs.cpSync(seed,b,{recursive:true});
    const x = applyRelation(a,'decoy'); const y = applyRelation(b,'decoy'); assert.equal(x.challengeSha256,y.challengeSha256); assert(x.decoys>0);
    const files=fs.readdirSync(path.join(a,'zz_cg_decoy'));
    for (const f of files) assert.equal(fs.readFileSync(path.join(a,'zz_cg_decoy',f),'utf8'),fs.readFileSync(path.join(b,'zz_cg_decoy',f),'utf8'));
    assert(!fs.readFileSync(path.join(a,'zz_cg_decoy/decoy_fns.py'),'utf8').includes('$okay'));
    fs.appendFileSync(path.join(b,'main.py'),'\nchanged()\n'); assert.notEqual(applyRelation(b,'repeat').challengeSha256,applyRelation(a,'repeat').challengeSha256);
  });
  check('TypeScript decoys exclude predefined type names as class declarations',()=>{
    const source=path.join(tmp,'ts-types');write(path.join(source,'main.ts'),'// A new string is produced\nexport function parse() { return "a"; }\n');
    applyRelation(source,'decoy');const classes=fs.readFileSync(path.join(source,'zz_cg_decoy/decoy-classes.ts'),'utf8');
    assert(!/class string\b/.test(classes),'invalid TypeScript class string generated from valid source');
  });
  check('shift validates source eligibility and preserves Python future-import placement', () => {
    const dir=path.join(tmp,'shift');fs.cpSync(seed,dir,{recursive:true});const out=applyRelation(dir,'shift');
    assert.deepEqual(out.shiftedFiles,['lib.ts','main.py']);const shifted=fs.readFileSync(path.join(dir,'main.py'),'utf8').split('\n');
    assert.equal(shifted.find(line=>line.trim()),'from __future__ import annotations');
    assert.equal(shifted.findIndex(line=>line.startsWith('class Widget')),4);
    const unsupported=path.join(tmp,'go');write(path.join(unsupported,'main.go'),'package main\nfunc main() {}\n');
    assert.equal(applyRelation(unsupported,'shift').notApplicable,true);assert.equal(applyRelation(unsupported,'decoy').notApplicable,true);
    assert.throws(()=>applyRelation(dir,'bogus'),/unknown relation/);
  });

  // The actual runner sees deliberately different subject graphs; challenge files must still match.
  const fake=path.join(tmp,'qa');
  for(const f of [...ADAPTER_SHARED,'lib/subjects/codegraph.mjs','lib/subjects/code-graph-rag.mjs','differential/modes.mjs','metamorphic/run.mjs','metamorphic/relations.mjs','lib/spec.mjs','lib/fixture-install.mjs'])write(path.join(fake,f),fs.readFileSync(path.join(qa,f),'utf8'));
  const fixture=path.join(fake,'fixtures/oracle-candidates/shared');fs.cpSync(seed,fixture,{recursive:true});write(path.join(fixture,'expect.json'),{secret:'EVALUATOR_ONLY'});
  const trace=path.join(tmp,'trace.jsonl');
  write(path.join(fake,'lib/subjects/index.mjs'),`import * as fs from 'node:fs';import * as path from 'node:path';
export const buildFor=(s,b)=>b;
export const subject=(name)=>({name,
 index(dir){if(fs.existsSync(path.join(dir,'expect.json')))throw Error('answers leaked');
 const decoy=path.join(dir,'zz_cg_decoy');if(fs.existsSync(decoy))fs.appendFileSync(process.env.CGQA_T3_TRACE,JSON.stringify({name,files:Object.fromEntries(fs.readdirSync(decoy).sort().map(f=>[f,fs.readFileSync(path.join(decoy,f),'utf8')]))})+'\\n');
 const mode=process.env.CGQA_T3_MODE;return{ok:!(mode==='setup-error'||(mode==='error'&&dir.endsWith('-repeat'))),output:'synthetic index error'};},
 snapshot(dir){const s={subject:{name},capabilities:{siteLines:true},files:[{path:'main.py'}],
 nodes:[{id:'1',name:'main.py',qname:'main.py',kind:'file',file:'main.py',start:1,end:6},{id:'2',name:'compute',qname:'compute',kind:'function',file:'main.py',start:4,end:4}],
 edges:[{kind:'calls',src:'1',dst:'2',line:5,col:0,provenance:null}],unresolved:[]};
 if(name==='code-graph-rag')s.nodes.push({id:'3',name:'rogueNameFromSubject',kind:'function',file:'main.py',start:1,end:1});
 if(dir.endsWith('-shift')){for(const n of s.nodes){if(n.kind!=='file')n.start+=3;n.end+=3;}for(const e of s.edges)e.line+=3;}
 if(dir.endsWith('-repeat')){if(process.env.CGQA_T3_MODE==='reorder'){s.nodes.reverse();for(const n of s.nodes)n.id='x'+n.id;for(const e of s.edges){e.src='x'+e.src;e.dst='x'+e.dst;}}
 if(process.env.CGQA_T3_MODE==='changed')s.edges=[];}return s;}});\n`);
  const outA=path.join(tmp,'meta-cg.json');const outB=path.join(tmp,'meta-cgr.json');
  const meta=(subject='codegraph',mode='stable',output=outA)=>run(path.join(fake,'metamorphic/run.mjs'),['--subject',subject,path.join(fake,'lib/subjects/codegraph.mjs'),'fixtures','--json',output],{CGQA_T3_TRACE:trace,CGQA_T3_MODE:mode});
  check('actual runner shares challenges across subjects with different graphs and isolates expectations',()=>{
    let r=meta();assert.equal(r.status,0,r.stdout+r.stderr);r=meta('code-graph-rag','stable',outB);assert.equal(r.status,0,r.stdout+r.stderr);
    const a=read(outA),b=read(outB);assert.equal(a.length,3);assert.deepEqual(a.map(x=>x.challengeSha256),b.map(x=>x.challengeSha256));
    const traces=fs.readFileSync(trace,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(traces[0].files,traces[1].files);assert(!JSON.stringify(traces).includes('rogueNameFromSubject'));
    assert.equal(a.find(x=>x.relation==='repeat').byteIdentical,true);
  });
  check('repeat raw drift is graph-stable; changed graphs exit1 and index errors exit2',()=>{
    let r=meta('codegraph','reorder');assert.equal(r.status,0,r.stdout+r.stderr);let repeat=read(outA).find(x=>x.relation==='repeat');assert.equal(repeat.byteIdentical,false);assert.equal(repeat.diffs.REPEAT.length,0);
    r=meta('codegraph','changed');assert.equal(r.status,1,r.stdout+r.stderr);assert(read(outA).find(x=>x.relation==='repeat').diffs.REPEAT.length);
    r=meta('codegraph','error');assert.equal(r.status,2,r.stdout+r.stderr);assert(read(outA).find(x=>x.relation==='repeat').error);
    r=meta('codegraph','setup-error');assert.equal(r.status,2,r.stdout+r.stderr);assert.equal(read(outA).length,3);assert(read(outA).every(x=>x.error));
  });
  check('actual tables show missing T3, retain identities, and reject mismatched canonical challenges',()=>{
    const corpus=path.join(tmp,'corpus.txt');write(corpus,'tiny https://example.invalid/tiny aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa typescript MIT dev small none\n');
    const output=path.join(tmp,'tables.json');const args=['--corpus',corpus,'--json',output];
    // canonical tables need every T2 run (SPEC §8), so the canonical cases get one per subject
    const work=path.join(tmp,'work');for(const sfx of ['','-code-graph-rag']){write(path.join(work,`w-pub-tiny${sfx}`,'out.json'),{buckets:{'ok|calls':1},skipped:{},spec:SPEC_VERSION});write(path.join(work,`w-pub-tiny${sfx}`,'out-missing.json'),{buckets:{'missing|found|ts|method':1},spec:SPEC_VERSION});}
    let r=run(path.join(qa,'bench/tables.mjs'),args,{ORACLE_WORK:path.join(tmp,'absent')});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/NOT RUN/);assert.equal(read(output).missingT3Runs.length,2);
    r=run(path.join(qa,'bench/tables.mjs'),[...args,'--canonical'],{ORACLE_WORK:work});assert.notEqual(r.status,0,'canonical output requires T3 even without --t3');
    const t3=path.join(tmp,'t3');write(path.join(t3,'meta-cg.json'),[row()]);write(path.join(t3,'meta-cgr.json'),[row({subject:'code-graph-rag'})]);
    r=run(path.join(qa,'bench/tables.mjs'),[...args,'--t3',t3],{ORACLE_WORK:path.join(tmp,'absent')});assert.equal(r.status,0,r.stderr);let data=read(output);assert.equal(data.t3Comparison.matched.length,1);assert.deepEqual(data.subjects.codegraph.robustness.adapterHashes,[hash]);
    r=run(path.join(qa,'bench/tables.mjs'),[...args,'--t3',t3,'--canonical'],{ORACLE_WORK:work});assert.notEqual(r.status,0,'partial matching relation files are not complete canonical T3');
    for(const [name,tag] of [['codegraph','cg'],['code-graph-rag','cgr']])write(path.join(t3,`meta-${tag}.json`),['decoy','shift','repeat'].map(relation=>row({subject:name,relation,byteIdentical:relation==='repeat'?true:undefined})));
    r=run(path.join(qa,'bench/tables.mjs'),[...args,'--t3',t3,'--canonical'],{ORACLE_WORK:work});assert.equal(r.status,0,r.stderr);
    write(path.join(t3,'meta-cgr.json'),[row({subject:'code-graph-rag',challengeSha256:other})]);
    r=run(path.join(qa,'bench/tables.mjs'),[...args,'--t3',t3,'--canonical'],{ORACLE_WORK:work});assert.notEqual(r.status,0);assert.match(r.stderr,/mismatched canonical T3/);
  });
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log(`${n}/${n} robustness checks`);

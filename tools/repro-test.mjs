#!/usr/bin/env node
// Execute Docker-context imports and the actual canonical orchestrator with offline subject shims.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SPEC_VERSION } from '../lib/spec.mjs';
const qa=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgqa-repro-test-'));let n=0;
const check=(name,fn)=>{fn();n++;console.log(`ok    ${name}`);};
const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const baseEnv={...process.env,XDG_CONFIG_HOME:tmp,XDG_CACHE_HOME:tmp,NODE_NO_WARNINGS:'1',CGQA_TEST_SPEC:SPEC_VERSION};
try{
 // These are the simple anchored/glob allowlist rules used by this repository's Docker context.
 const rules=fs.readFileSync(path.join(qa,'.dockerignore'),'utf8').split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
 const allowed=rel=>{let include=true;for(const raw of rules){const allow=raw.startsWith('!');const glob=(allow?raw.slice(1):raw).replace(/\/$/,'');if(path.matchesGlob(rel,glob))include=allow;}return include;};
 const context=path.join(tmp,'context');fs.mkdirSync(context);
 const copy=(rel='')=>{for(const e of fs.readdirSync(path.join(qa,rel),{withFileTypes:true})){const f=path.posix.join(rel,e.name);if(!allowed(f))continue;const target=path.join(context,f);if(e.isDirectory()){fs.mkdirSync(target,{recursive:true});copy(f);}else if(e.isFile()){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(qa,f),target);}}};copy();
 check('Docker runtime context includes T3 imports and executes the actual tables CLI',()=>{
  for(const f of ['bench/robustness.mjs','metamorphic/run.mjs','metamorphic/relations.mjs'])assert(fs.existsSync(path.join(context,f)),`Docker context missing ${f}`);
  // The real noise step verifies the pinned labelling protocol inside the image's file set (SPEC §9).
  {const d=path.join(context,'labels','data');const samples=fs.readdirSync(d).sort().flatMap(x=>[path.join(d,x,'items.jsonl'),path.join(d,x)]);
   const r=spawnSync(process.execPath,[path.join(context,'labels','noise.mjs'),...samples,'--protocol',path.join(context,'labels','protocol.json'),'--json',path.join(tmp,'noise-context.json')],{encoding:'utf8'});
   assert.equal(r.status,0,`noise --protocol in the Docker context: ${r.stderr}`);}
  const r=spawnSync(process.execPath,[path.join(context,'bench/tables.mjs')],{encoding:'utf8',env:{...baseEnv,ORACLE_WORK:path.join(tmp,'no-oracle')}});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/T3 robustness/);
 });
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
 const shim=(name,code)=>{const f=path.join(bin,name);write(f,`#!${process.execPath}\n${code}\n`);fs.chmodSync(f,0o755);};
 shim('unshare','process.exit(17);');
 const run=(root,out,extra={})=>spawnSync(process.execPath,[path.join(root,'tools/repro.mjs'),'--repo','mux','--out',out],{cwd:root,encoding:'utf8',env:{...baseEnv,PATH:`${bin}:${process.env.PATH}`,...extra}});
 check('manifest fingerprints the real repeat comparator before any external command',()=>{
  const out=path.join(tmp,'init');const r=run(qa,out);assert.equal(r.status,1);const m=read(path.join(out,'manifest.json'));
  const expected=createHash('sha256').update(fs.readFileSync(path.join(qa,'differential/modes.mjs'))).digest('hex');
  assert.equal(m.files['differential/modes.mjs'],expected,'repeat comparator missing from scorer provenance');assert.equal(m.status,'failed');assert.match(m.error,/namespace-check/);
 });
 shim('unshare','process.exit(0);');
 shim('git',`const fs=require('node:fs');if(process.argv[2]==='init')fs.mkdirSync('.git',{recursive:true});`);
 shim('bash',`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args[0]!=='oracle/run.sh')process.exit(9);
 const subject=process.env.CGQA_SUBJECT;const work=path.join(process.env.ORACLE_WORK,'w-'+args[1]+(subject==='codegraph'?'':'-code-graph-rag'));fs.mkdirSync(work,{recursive:true});
 for(const [name,buckets]of[['out.json',{'ok|calls':1}],['out-missing.json',{'missing|found|go':1}]])fs.writeFileSync(path.join(work,name),JSON.stringify({total:1,buckets,groups:{},adapterSha256:'a'.repeat(64),spec:process.env.CGQA_TEST_SPEC}));`);
 shim('node',`const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const a=process.argv.slice(2),script=a[0];
 if(script==='-e'){console.log(JSON.stringify({codegraph:'test',cgr:'test',tools:{}}));process.exit(0);}
 if(script==='bench/tables.mjs'){const r=cp.spawnSync(process.execPath,[path.resolve(script),...a.slice(1)],{stdio:'inherit',env:process.env});process.exit(r.status??1);}
 const output=a[a.indexOf('--json')+1],subject=a.includes('--subject')?a[a.indexOf('--subject')+1]:'codegraph';let data;
 if(script==='fixtures/replay.mjs')data={subject,adapterSha256:'a'.repeat(64),results:[{name:'f',verdict:'FIXED'}]};
 else if(script==='benchmarks/pycg.mjs')data={subject,adapterSha256:'a'.repeat(64),results:[{name:'x',hit:1}],categories:{x:{expected:1,hit:1,extra:0}}};
 else if(script==='metamorphic/run.mjs'){const status=Number(process.env.CGQA_T3_REPRO_STATUS??1);data=['decoy','shift','repeat'].map(relation=>({seed:'f',relation,subject,adapterSha256:'a'.repeat(64),challengeSha256:'b'.repeat(64),byteIdentical:relation==='repeat'?true:undefined,diffs:{LOST:status===1&&relation==='decoy'?['changed']:[]},...(status===2?{error:'synthetic index failure'}:{})}));fs.writeFileSync(output,JSON.stringify(data));process.exit(status);}
 else if(script==='labels/noise.mjs')data={table:{},labellers:[],protocol:a.includes('--protocol')?{sha256:'0'.repeat(64),name:'test',promptTemplateSha256:'0'.repeat(64),labellers:{}}:null};else process.exit(9);
 fs.writeFileSync(output,JSON.stringify(data));`);
 check('canonical orchestrator records exit1 findings and runs actual T1/T2/T3 table code',()=>{
  const out=path.join(tmp,'findings');const r=run(context,out,{CGQA_T3_REPRO_STATUS:'1'});assert.equal(r.status,0,r.stdout+r.stderr);
  const m=read(path.join(out,'manifest.json'));assert.equal(m.status,'complete');assert(m.files['differential/modes.mjs']);
  const t=read(path.join(out,'tables.json'));assert.equal(t.t3Comparison.matched.length,3);assert.equal(t.subjects.codegraph.robustness.relations.decoy.changed,1);assert.equal(t.missingRuns.length,0);
 });
 check('canonical index error exit2 retains failed manifest and logs, without success table',()=>{
  const out=path.join(tmp,'error');const r=run(context,out,{CGQA_T3_REPRO_STATUS:'2'});assert.equal(r.status,1,r.stdout+r.stderr);
  const m=read(path.join(out,'manifest.json'));assert.equal(m.status,'failed');assert.match(m.error,/t3-cg/);assert(fs.existsSync(path.join(out,'logs/t3-cg.log')));assert(!fs.existsSync(path.join(out,'tables.json')));
 });
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log(`${n}/${n} reproduction checks`);

#!/usr/bin/env node
// Execute Docker-context imports and the actual canonical orchestrator with offline subject shims.
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SPEC_VERSION } from '../lib/spec.ts';
const qa=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgqa-repro-test-'));let n=0;
const check=(name,fn)=>{fn();n++;console.log(`ok    ${name}`);};
// The image's entry point (#39 review L1; strict since round 3). The final build stage must COPY the context
// into WORKDIR (`COPY . .`) and hold exactly one ENTRYPOINT of the form ["node", "<relative script>"]. Any
// other shape fails with a reason, so changing the ENTRYPOINT means changing this check too.
function entrypointScript(dockerfile){
  const stage=dockerfile.split(/^FROM\s/im).pop();
  if(!/^COPY\s+\.\s+\.\s*$/m.test(stage))return{error:'the final stage must COPY . . (the context lands in WORKDIR)'};
  const eps=[...stage.matchAll(/^ENTRYPOINT\s+(.*)$/gim)].map((m)=>m[1].trim());
  if(eps.length!==1)return{error:`the final stage needs exactly one ENTRYPOINT, found ${eps.length}`};
  const m=/^\["node", "([^"/-][^"]*)"\]$/.exec(eps[0]);
  return m?{script:m[1]}:{error:`ENTRYPOINT must be ["node", "<relative script>"]: ${eps[0]}`};
}
const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const baseEnv={...process.env,XDG_CONFIG_HOME:tmp,XDG_CACHE_HOME:tmp,NODE_NO_WARNINGS:'1',CGQA_TEST_SPEC:SPEC_VERSION};
try{
 // These are the simple anchored/glob allowlist rules used by this repository's Docker context.
 const rules=fs.readFileSync(path.join(qa,'.dockerignore'),'utf8').split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
 const allowed=rel=>{let include=true;for(const raw of rules){const allow=raw.startsWith('!');const glob=(allow?raw.slice(1):raw).replace(/\/$/,'');if(path.matchesGlob(rel,glob))include=allow;}return include;};
 const context=path.join(tmp,'context');fs.mkdirSync(context);
 const copy=(rel='')=>{for(const e of fs.readdirSync(path.join(qa,rel),{withFileTypes:true})){const f=path.posix.join(rel,e.name);if(!allowed(f))continue;const target=path.join(context,f);if(e.isDirectory()){fs.mkdirSync(target,{recursive:true});copy(f);}else if(e.isFile()){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(qa,f),target);}}};copy();
 check('the ENTRYPOINT check accepts only the final stage\'s exact ["node", "<script>"]',()=>{
  const W='WORKDIR /opt/graph-assay\nCOPY . .\n';
  assert.deepEqual(entrypointScript(`FROM a\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\n`),{script:'tools/repro.ts'});
  // An earlier stage's ENTRYPOINT or COPY never counts (round 3 F1).
  assert.match(entrypointScript(`FROM a AS b\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\nFROM c\nCOPY . /srv\n`).error,/must COPY/);
  assert.match(entrypointScript(`FROM a AS b\nENTRYPOINT ["node", "early.ts"]\nFROM c\n${W}`).error,/found 0/);
  assert.match(entrypointScript(`FROM a\n${W}ENTRYPOINT ["node", "a.ts"]\nENTRYPOINT ["node", "b.ts"]\n`).error,/found 2/);
  for(const ep of ['node tools/repro.ts','["node", "/opt/graph-assay/tools/repro.ts"]','["node", "--import", "x.ts", "tools/repro.ts"]','["python3", "x.py"]','["node"]','["node", 1]'])
   assert.match(entrypointScript(`FROM a\n${W}ENTRYPOINT ${ep}\n`).error,/must be \["node"/,ep);
 });
 check('Docker runtime context includes T3 imports and executes the actual tables CLI',()=>{
  // Every script tools/repro.ts runs in the image, and the package.json markers that make its .ts load as ES modules (#35 review G2).
  for(const f of ['bench/robustness.ts','bench/tables.ts','metamorphic/run.ts','metamorphic/relations.ts','fixtures/replay.mts','benchmarks/pycg.ts','differential/builds.ts','differential/modes.ts','oracle/oracle.ts','oracle/run.sh',
    'labels/noise.ts','labels/questions.ts','labels/score.ts','labels/protocol.ts','labels/labellers.ts','lib/package.json','oracle/package.json','bench/package.json','metamorphic/package.json','benchmarks/package.json','differential/package.json','labels/package.json','tools/package.json'])assert(fs.existsSync(path.join(context,f)),`Docker context missing ${f}`);
  // The image's entry point names a script the context holds (#39 review L1).
  {const ep=entrypointScript(fs.readFileSync(path.join(qa,'Dockerfile'),'utf8'));assert(!ep.error,ep.error);
   // A file, not a directory (round 3 F2).
   assert(fs.statSync(path.join(context,ep.script),{throwIfNoEntry:false})?.isFile(),`Docker ENTRYPOINT script ${ep.script} missing from the context`);}
  // The real noise step verifies the pinned labelling protocol inside the image's file set (SPEC §9).
  {const d=path.join(context,'labels','data');const samples=fs.readdirSync(d).sort().flatMap(x=>[path.join(d,x,'items.jsonl'),path.join(d,x)]);
   const r=spawnSync(process.execPath,[path.join(context,'labels','noise.ts'),...samples,'--protocol',path.join(context,'labels','protocol.json'),'--json',path.join(tmp,'noise-context.json')],{encoding:'utf8'});
   assert.equal(r.status,0,`noise --protocol in the Docker context: ${r.stderr}`);}
  const r=spawnSync(process.execPath,[path.join(context,'bench/tables.ts')],{encoding:'utf8',env:{...baseEnv,ORACLE_WORK:path.join(tmp,'no-oracle')}});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/T3 robustness/);
 });
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
 const shim=(name,code)=>{const f=path.join(bin,name);write(f,`#!${process.execPath}\n${code}\n`);fs.chmodSync(f,0o755);};
 shim('unshare','process.exit(17);');
 const run=(root,out,extra={})=>spawnSync(process.execPath,[path.join(root,'tools/repro.ts'),'--repo','mux','--out',out],{cwd:root,encoding:'utf8',env:{...baseEnv,PATH:`${bin}:${process.env.PATH}`,...extra}});
 check('manifest fingerprints the real repeat comparator before any external command',()=>{
  const out=path.join(tmp,'init');const r=run(qa,out);assert.equal(r.status,1);const m=read(path.join(out,'manifest.json'));
  const expected=createHash('sha256').update(fs.readFileSync(path.join(qa,'differential/modes.ts'))).digest('hex');
  assert.equal(m.files['differential/modes.ts'],expected,'repeat comparator missing from scorer provenance');
  // Its package.json decides how it loads, as lib/manifest.ts's scorer hash already records (#35 review G1).
  assert.equal(m.files['differential/package.json'],createHash('sha256').update(fs.readFileSync(path.join(qa,'differential/package.json'))).digest('hex'),'differential/package.json missing from scorer provenance');
  // tools/package.json decides how the entry point loads (#39 review L2).
  assert.equal(m.files['tools/package.json'],createHash('sha256').update(fs.readFileSync(path.join(qa,'tools/package.json'))).digest('hex'),'tools/package.json (the entry point\'s module marker) missing from the repro manifest');assert.equal(m.status,'failed');assert.match(m.error,/namespace-check/);
 });
 shim('unshare','process.exit(0);');
 shim('git',`const fs=require('node:fs');if(process.argv[2]==='init')fs.mkdirSync('.git',{recursive:true});`);
 shim('bash',`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args[0]!=='oracle/run.sh')process.exit(9);
 const subject=process.env.CGQA_SUBJECT;const work=path.join(process.env.ORACLE_WORK,'w-'+args[1]+(subject==='codegraph'?'':'-code-graph-rag'));fs.mkdirSync(work,{recursive:true});
 for(const [name,buckets]of[['out.json',{'ok|calls':1}],['out-missing.json',{'missing|found|go':1}]])fs.writeFileSync(path.join(work,name),JSON.stringify({total:1,buckets,groups:{},adapterSha256:'a'.repeat(64),spec:process.env.CGQA_TEST_SPEC}));`);
 shim('node',`const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const a=process.argv.slice(2),script=a[0];
 if(script==='-e'){console.log(JSON.stringify({codegraph:'test',cgr:'test',tools:{}}));process.exit(0);}
 if(script==='bench/tables.ts'){const r=cp.spawnSync(process.execPath,[path.resolve(script),...a.slice(1)],{stdio:'inherit',env:process.env});process.exit(r.status??1);}
 const output=a[a.indexOf('--json')+1],subject=a.includes('--subject')?a[a.indexOf('--subject')+1]:'codegraph';let data;
 if(script==='fixtures/replay.mts')data={subject,adapterSha256:'a'.repeat(64),results:[{name:'f',verdict:'FIXED'}]};
 else if(script==='benchmarks/pycg.ts')data={subject,adapterSha256:'a'.repeat(64),results:[{name:'x',hit:1}],categories:{x:{expected:1,hit:1,extra:0}}};
 else if(script==='metamorphic/run.ts'){const status=Number(process.env.CGQA_T3_REPRO_STATUS??1);data=['decoy','shift','repeat'].map(relation=>({seed:'f',relation,subject,adapterSha256:'a'.repeat(64),challengeSha256:'b'.repeat(64),byteIdentical:relation==='repeat'?true:undefined,diffs:{LOST:status===1&&relation==='decoy'?['changed']:[]},...(status===2?{error:'synthetic index failure'}:{})}));fs.writeFileSync(output,JSON.stringify(data));process.exit(status);}
 else if(script==='labels/noise.ts')data={table:{},labellers:[],protocol:a.includes('--protocol')?{sha256:'0'.repeat(64),name:'test',promptTemplateSha256:'0'.repeat(64),labellers:{}}:null};else process.exit(9);
 fs.writeFileSync(output,JSON.stringify(data));`);
 check('canonical orchestrator records exit1 findings and runs actual T1/T2/T3 table code',()=>{
  const out=path.join(tmp,'findings');const r=run(context,out,{CGQA_T3_REPRO_STATUS:'1'});assert.equal(r.status,0,r.stdout+r.stderr);
  const m=read(path.join(out,'manifest.json'));assert.equal(m.status,'complete');assert(m.files['differential/modes.ts']);
  const t=read(path.join(out,'tables.json'));assert.equal(t.t3Comparison.matched.length,3);assert.equal(t.subjects.codegraph.robustness.relations.decoy.changed,1);assert.equal(t.missingRuns.length,0);
 });
 check('canonical index error exit2 retains failed manifest and logs, without success table',()=>{
  const out=path.join(tmp,'error');const r=run(context,out,{CGQA_T3_REPRO_STATUS:'2'});assert.equal(r.status,1,r.stdout+r.stderr);
  const m=read(path.join(out,'manifest.json'));assert.equal(m.status,'failed');assert.match(m.error,/t3-cg/);assert(fs.existsSync(path.join(out,'logs/t3-cg.log')));assert(!fs.existsSync(path.join(out,'tables.json')));
 });
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log(`${n}/${n} reproduction checks`);

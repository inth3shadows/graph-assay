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
import { CORPUS, readRepos } from '../differential/builds.ts';
import { SCORING_ENTRIES, importClosure } from '../lib/manifest.ts';
const qa=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cgqa-repro-test-'));let n=0;
const check=(name,fn)=>{fn();n++;console.log(`ok    ${name}`);};
// The image's entry point (#39 review L1; strict since round 3; #41: pinned to the final three instructions).
// The final build stage must end with exactly `WORKDIR /opt/graph-assay`, `COPY . .` and one ENTRYPOINT of
// the form ["node", "<relative script>"], so the context lands where the script runs. Instructions are read as
// Docker reads them: continuation lines joined, comments dropped, keywords in any case. Any other shape
// fails with a reason, so changing the ENTRYPOINT means changing this check too.
function entrypointScript(dockerfile){
  // Docker drops comment lines (and blank ones) before joining a line that ends in `\\` to the next.
  const ins=[];let cur='';
  for(const raw of dockerfile.split(/\r?\n/)){const t=raw.trim();if(!t||t.startsWith('#'))continue;
    if(/\\$/.test(t)){cur+=t.slice(0,-1)+' ';continue;}ins.push((cur+t).trim());cur='';}
  if(cur.trim())ins.push(cur.trim());
  // Keywords in any case; arguments as written.
  const I={kw:(x)=>(/^(\S+)/.exec(x)?.[1]??'').toUpperCase(),arg:(x)=>x.replace(/^\S+\s*/,'')};
  const stage=ins.slice(ins.map((x)=>I.kw(x)==='FROM').lastIndexOf(true)+1);
  const eps=stage.filter((x)=>I.kw(x)==='ENTRYPOINT');
  if(eps.length!==1)return{error:`the final stage needs exactly one ENTRYPOINT, found ${eps.length}`};
  const [w,c,e]=stage.slice(-3);
  if(!w||I.kw(w)!=='WORKDIR'||I.arg(w)!=='/opt/graph-assay'||!c||I.kw(c)!=='COPY'||!/^\.\s+\.$/.test(I.arg(c))||e!==eps[0])
    return{error:'the final stage must end with WORKDIR /opt/graph-assay, COPY . . and the ENTRYPOINT, in that order'};
  const m=/^\["node", "([^"]+)"\]$/.exec(I.arg(e));
  if(!m||m[1].startsWith('/')||m[1].startsWith('-')||m[1].split('/').includes('..'))return{error:`ENTRYPOINT must be ["node", "<relative script>"]: ${I.arg(e)}`};
  return{script:m[1]};
}
// #41: the context as Docker builds it (moby/patternmatcher): `**` matches any path, dot-paths too; `*` and
// `?` stay within a segment; `[...]` is a character class and `\\` escapes; a rule that matches a parent
// directory applies to everything under it; the last matching rule wins. Docker skips an excluded
// directory unless an exception rule could match something under it. Checked against a real context
// export (all 479 files) when it was written.
// The pattern forms dockerMatcher is checked against Docker on: path characters, `*`, `?`, `**` as a whole
// segment, a leading `!` or `/`, a trailing `/`. Anything else (character classes, escapes, regexp
// characters moby passes through, `**` inside a segment, `..`, leading spaces) is refused, so a new
// .dockerignore rule outside the subset fails here instead of being emulated wrongly.
function unsupportedRule(raw){
  if(/^\s|\s$/.test(raw))return'leading or trailing whitespace';
  const g=raw.replace(/^!/,'').replace(/^\//,'').replace(/\/$/,'');
  if(!/^[A-Za-z0-9_.\-/*?]+$/.test(g))return'a character outside [A-Za-z0-9_.-/*?]';
  if(g.split('/').some((seg)=>seg.includes('**')&&seg!=='**'))return'** inside a path segment';
  if(g.split('/').includes('..'))return'a .. segment';
  return null;
}
function dockerMatcher(rules){
  const re=(g)=>{let r='';for(let i=0;i<g.length;i++){const ch=g[i];
    if(ch==='*'&&g[i+1]==='*'){i++;if(g[i+1]==='/')i++;r+=i+1>=g.length?'.*':'(?:.*/)?';}
    else if(ch==='*')r+='[^/]*';else if(ch==='?')r+='[^/]';
    else if(ch==='\\'&&i+1<g.length){i++;r+=g[i].replace(/[.*+?^${}()|[\]\\/]/g,'\\$&');}
    else r+='.+()|{}$'.includes(ch)?`\\${ch}`:ch;}
    return new RegExp(`^${r}$`);};
  const parsed=rules.map((raw)=>{const allow=raw.startsWith('!');const g=path.posix.normalize((allow?raw.slice(1):raw).replace(/^\//,'')).replace(/\/$/,'');
    return{allow,re:re(g),g};});
  const allowed=(rel)=>{const parts=rel.split('/');let inc=true;for(const p of parsed)if(parts.some((_,i)=>p.re.test(parts.slice(0,i+1).join('/'))))inc=p.allow;return inc;};
  // Docker's walk enters an excluded directory only when an exception pattern's text starts with it
  // (moby pkg/archive: strings.HasPrefix(pattern+"/", dir+"/")); a ** in the pattern does not widen that.
  allowed.mayEnter=(dir)=>parsed.some((p)=>p.allow&&`${p.g}/`.startsWith(`${dir}/`));
  return allowed;
}
const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const baseEnv={...process.env,XDG_CONFIG_HOME:tmp,XDG_CACHE_HOME:tmp,NODE_NO_WARNINGS:'1',CGQA_TEST_SPEC:SPEC_VERSION};
try{
 const rules=fs.readFileSync(path.join(qa,'.dockerignore'),'utf8').split('\n').filter(s=>s.trim()&&!s.startsWith('#'));
 {const bad=rules.map((r)=>[r,unsupportedRule(r)]).filter(([,why])=>why);
  assert.deepEqual(bad,[],`.dockerignore uses pattern forms repro-test does not emulate (verify them against a real docker build, then extend dockerMatcher): ${bad.map(([r,why])=>`'${r}' (${why})`).join(', ')}`);}
 const allowed=dockerMatcher(rules);
 const context=path.join(tmp,'context');fs.mkdirSync(context);
 const copy=(rel='')=>{for(const e of fs.readdirSync(path.join(qa,rel),{withFileTypes:true})){const f=path.posix.join(rel,e.name);if(e.isDirectory()){if(allowed(f)||allowed.mayEnter(f))copy(f);}else if(e.isFile()&&allowed(f)){const target=path.join(context,f);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(qa,f),target);}}};copy();
 check('the context emulation follows Docker\'s matcher (#41)',()=>{
  const m=dockerMatcher(['**','!tools/','!a/*.ts','**/.env*','!keep/**']);
  assert.ok(m('tools/x.sh')&&m('tools/sub/y.sh'),'a rule on a parent directory applies to its children');
  assert.ok(!m('.env')&&!m('a/.env.local'),'** matches dot-paths');
  assert.ok(m('a/b.ts')&&!m('a/b/c.ts')&&!m('a/b.js'),'* stays within a segment');
  assert.ok(!m('.docvet.json')&&!m('.github/x.yml'),'root dotfiles stay excluded');
  assert.ok(m('keep/.x/y'),'a later ! rule re-includes under an excluded dot-directory');
  const k=dockerMatcher(['**','!a/**.map','!b/[a-c]*.ts','!lit\\[x\\].txt']);
  // Checked against a real build: of a/x.map, a/.map, a/d/.map and a/d/y.map, Docker sends only a/.map.
  assert.ok(k('a/.map')&&!k('a/x.map'),'** before more pattern is (.*/)?, as moby compiles it (so a/**.map needs a segment named .map)');
  assert.ok(k.mayEnter('a')&&!k.mayEnter('a/d'),'the walk never enters a/d for a/**.map');
  // The repo's .dockerignore stays inside the verified subset; forms outside it are refused by name.
  for(const r of ['**','!lib/**','**/.env*','!oracle/*.sh','!x?.ts','/abs/','!dir/'])assert.equal(unsupportedRule(r),null,r);
  for(const [r,why] of [['!b/[a-c]*.ts','character'],['a\\[x\\]','character'],['**.map','inside a path segment'],['a/**x','inside a path segment'],['p/a^b','character'],['!p/a|b','character'],['../x','..'],['  #x','whitespace'],['! lib/x','character']])
   assert.match(unsupportedRule(r)??'',new RegExp(why),r);
  assert.ok(k('b/a1.ts')&&!k('b/z1.ts'),'[...] is a character class');
  assert.ok(k('lit[x].txt'),'a backslash escapes');
  assert.ok(m.mayEnter('tools')&&m.mayEnter('keep')&&!m.mayEnter('z'),'an excluded directory is entered only when an exception rule leads into it');
 });
 check('the ENTRYPOINT check accepts only a final stage ending WORKDIR, COPY . ., ["node", "<script>"]',()=>{
  const W='WORKDIR /opt/graph-assay\nCOPY . .\n';
  assert.deepEqual(entrypointScript(`FROM a\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\n`),{script:'tools/repro.ts'});
  // An earlier stage's ENTRYPOINT or COPY never counts (round 3 F1).
  assert.match(entrypointScript(`FROM a AS b\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\nFROM c\nCOPY . /srv\n`).error,/found 0/);
  assert.match(entrypointScript(`FROM a AS b\nENTRYPOINT ["node", "early.ts"]\nFROM c\n${W}`).error,/found 0/);
  assert.match(entrypointScript(`FROM a\n${W}ENTRYPOINT ["node", "a.ts"]\nENTRYPOINT ["node", "b.ts"]\n`).error,/found 2/);
  for(const ep of ['node tools/repro.ts','["node", "/opt/graph-assay/tools/repro.ts"]','["node", "--import", "x.ts", "tools/repro.ts"]','["python3", "x.py"]','["node"]','["node", 1]','["node", "../x.ts"]','["node", "tools/../../x.ts"]'])
   assert.match(entrypointScript(`FROM a\n${W}ENTRYPOINT ${ep}\n`).error,/must be \["node"/,ep);
  // #41: the order of the last three instructions decides where the context lands relative to the script.
  for(const tail of ['COPY . .\nWORKDIR /opt/graph-assay\n','WORKDIR /opt/graph-assay\nCOPY . .\nWORKDIR /elsewhere\n','WORKDIR /srv\nCOPY . .\n','COPY . .\n'])
   assert.match(entrypointScript(`FROM a\n${tail}ENTRYPOINT ["node", "tools/repro.ts"]\n`).error,/must end with WORKDIR/,tail);
  assert.match(entrypointScript(`FROM a\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\nUSER nobody\n`).error,/must end with WORKDIR/);
  // Arguments are matched as written: only keywords are case-insensitive.
  assert.match(entrypointScript(`FROM a\nWORKDIR /OPT/GRAPH-ASSAY\nCOPY . .\nENTRYPOINT ["node", "tools/repro.ts"]\n`).error,/must end with WORKDIR/);
  assert.match(entrypointScript(`FROM a\n${W}ENTRYPOINT ["NODE", "tools/repro.ts"]\n`).error,/must be \["node"/);
  // A comment line never continues, and one inside a continuation is dropped.
  assert.deepEqual(entrypointScript(`FROM a\n# note \\\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\n`),{script:'tools/repro.ts'});
  assert.match(entrypointScript(`FROM a AS b\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\n# x \\\nFROM c\nRUN true\n`).error,/found 0/);
  assert.deepEqual(entrypointScript(`FROM a\nRUN a && \\\n# note\n  b\n${W}ENTRYPOINT ["node", "tools/repro.ts"]\n`),{script:'tools/repro.ts'});
  // Instructions are read as Docker reads them: a continuation line starting `from` is not a stage, keywords in any case.
  assert.deepEqual(entrypointScript(`FROM a\nRUN echo \\\n  from b\nworkdir /opt/graph-assay\ncopy . .\nentrypoint ["node", "tools/repro.ts"]\n`),{script:'tools/repro.ts'});
 });
 check('Docker runtime context includes T3 imports and executes the actual tables CLI',()=>{
  // Every script tools/repro.ts runs in the image, and the package.json markers that make its .ts load as ES modules (#35 review G2).
  for(const f of ['bench/robustness.ts','bench/tables.ts','metamorphic/run.ts','metamorphic/relations.ts','fixtures/replay.mts','benchmarks/pycg.ts','differential/builds.ts','differential/modes.ts','oracle/oracle.ts','oracle/run.sh',
    'labels/noise.ts','labels/questions.ts','labels/score.ts','labels/strata.ts','labels/protocol.ts','labels/labellers.ts','lib/package.json','oracle/package.json','bench/package.json','metamorphic/package.json','benchmarks/package.json','differential/package.json','labels/package.json','tools/package.json',
    // #41: what the image needs beyond scripts: the Dockerfile's COPY docker/package*.json, and the fixtures replay and T3 read.
    'docker/package.json','docker/package-lock.json'])assert(fs.existsSync(path.join(context,f)),`Docker context missing ${f}`);
  assert(fs.existsSync(path.join(context,'fixtures','oracle-candidates'))&&fs.readdirSync(path.join(context,'fixtures','oracle-candidates')).some((d)=>fs.existsSync(path.join(context,'fixtures','oracle-candidates',d,'expect.json'))),'Docker context has no fixture under fixtures/oracle-candidates/');
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
  assert.equal(m.files['tools/package.json'],createHash('sha256').update(fs.readFileSync(path.join(qa,'tools/package.json'))).digest('hex'),'tools/package.json (the entry point\'s module marker) missing from the repro manifest');
  // Every file a scoring script or the entry point loads, with its package.json (#41: differential/builds.ts was missing).
  {const missing=importClosure([...SCORING_ENTRIES,'tools/repro.ts']).filter(f=>!(f in m.files));assert.deepEqual(missing,[],`repro manifest leaves out: ${missing.join(', ')}`);}assert.equal(m.status,'failed');assert.match(m.error,/namespace-check/);
 });
 check('--split heldout needs --publish; the usage names every corpus repo; the split is recorded',()=>{
  const go=(argv)=>spawnSync(process.execPath,[path.join(qa,'tools/repro.ts'),...argv],{cwd:qa,encoding:'utf8',env:{...baseEnv,PATH:`${bin}:${process.env.PATH}`}});
  const refused=go(['--split','heldout','--repo','httpx','--out',path.join(tmp,'held-refused')]);
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/reserved for publication.*--publish/s);assert(!fs.existsSync(path.join(tmp,'held-refused')),'a refused run must not create its output');
  // With --publish it passes parsing and reaches the (shimmed, failing) namespace check; no reproduction runs.
  const out=path.join(tmp,'held-ok');const ok=go(['--split','heldout','--publish','--repo','httpx','--out',out]);
  assert.equal(ok.status,1,ok.stdout+ok.stderr);const m=read(path.join(out,'manifest.json'));
  assert.match(m.error,/namespace-check/);assert.equal(m.split,'heldout');assert.equal(m.publish,true);assert.deepEqual(m.repos.map(r=>r.name),['httpx']);
  // A dev repo is not in the held-out split; --publish does not change the dev split.
  assert.match(go(['--split','heldout','--publish','--repo','mux','--out',path.join(tmp,'h2')]).stderr,/Unknown heldout repo: mux/);
  // --publish without --split heldout is refused, so a dev manifest never claims a publication run (#53 review L1).
  for(const argv of [['--split','dev','--repo','mux','--publish'],['--publish','--repo','mux']]){const o=path.join(tmp,'dev-pub');const r=go([...argv,'--out',o]);
   assert.notEqual(r.status,0);assert.match(r.stderr,/--publish applies only to --split heldout/,argv.join(' '));assert(!fs.existsSync(o),'a refused run must not create its output');}
  const devPlain=path.join(tmp,'dev-plain');go(['--repo','mux','--out',devPlain]);const dm=read(path.join(devPlain,'manifest.json'));assert.equal(dm.split,'dev');assert.equal(dm.publish,false);
  assert.match(go(['--split','bogus']).stderr,/Unknown split/);
  // Every npm corpus entry has the frozen lock the image installs from, and a missing one fails before anything is fetched (#53 review H1).
  for(const r of readRepos(CORPUS).filter(r=>r.setup==='npm'))assert(fs.existsSync(path.join(qa,'docker',`${r.name}-package-lock.json`)),`docker/${r.name}-package-lock.json missing`);
    const help=go(['--help']);assert.equal(help.status,0);for(const name of ['mux','requests','httpx','cobra','got'])assert.match(help.stdout,new RegExp(name),`usage lacks ${name}`);
 });
 shim('unshare','process.exit(0);');
 shim('git',`const fs=require('node:fs');if(process.argv[2]==='init')fs.mkdirSync('.git',{recursive:true});`);
 shim('bash',`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args[0]!=='oracle/run.sh')process.exit(9);
 const subject=process.env.CGQA_SUBJECT;const work=path.join(process.env.ORACLE_WORK,'w-'+args[1]+(subject==='codegraph'?'':'-code-graph-rag'));fs.mkdirSync(work,{recursive:true});
 for(const [name,buckets]of[['out.json',{'ok|calls':1}],['out-missing.json',{'missing|found|go':1}]])fs.writeFileSync(path.join(work,name),JSON.stringify({total:1,buckets,groups:{},sites:[],adapterSha256:'a'.repeat(64),spec:process.env.CGQA_TEST_SPEC}));`);
 shim('node',`const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const a=process.argv.slice(2),script=a[0];
 if(script==='-e'){console.log(JSON.stringify({codegraph:'test',cgr:'test',tools:{}}));process.exit(0);}
 if(script==='bench/tables.ts'){const r=cp.spawnSync(process.execPath,[path.resolve(script),...a.slice(1)],{stdio:'inherit',env:process.env});process.exit(r.status??1);}
 const output=a[a.indexOf('--json')+1],subject=a.includes('--subject')?a[a.indexOf('--subject')+1]:'codegraph';let data;
 if(script==='fixtures/replay.mts')data={subject,adapterSha256:'a'.repeat(64),results:[{name:'f',verdict:'FIXED'}]};
 else if(script==='benchmarks/pycg.ts')data={subject,adapterSha256:'a'.repeat(64),results:[{name:'x',hit:1}],categories:{x:{expected:1,hit:1,extra:0}}};
 else if(script==='metamorphic/run.ts'){const status=Number(process.env.CGQA_T3_REPRO_STATUS??1);data=['decoy','shift','repeat'].map(relation=>({seed:'f',relation,subject,adapterSha256:'a'.repeat(64),challengeSha256:'b'.repeat(64),byteIdentical:relation==='repeat'?true:undefined,diffs:{LOST:status===1&&relation==='decoy'?['changed']:[]},...(status===2?{error:'synthetic index failure'}:{})}));fs.writeFileSync(output,JSON.stringify(data));process.exit(status);}
 else if(script==='labels/noise.ts')data={table:{},labellers:[],protocol:a.includes('--protocol')?{sha256:'0'.repeat(64),name:'test',promptTemplateSha256:'0'.repeat(64),labellers:{}}:null};else process.exit(9);
 fs.writeFileSync(output,JSON.stringify(data));`);
 shim('npm',`const fs=require('node:fs');if(process.argv[2]!=='ci'||!fs.existsSync('package-lock.json'))process.exit(9);`);
 check('a held-out publish run fetches, sets up and tables the held-out split, never dev',()=>{
  // The split reaches the fetch, the npm setup (got's lock) and bench/tables.ts --split (#53 review M2, H1).
  const out=path.join(tmp,'heldout');const held=readRepos(CORPUS,'heldout').map(r=>r.name).sort();
  const r=spawnSync(process.execPath,[path.join(context,'tools/repro.ts'),'--split','heldout','--publish','--out',out],{cwd:context,encoding:'utf8',env:{...baseEnv,PATH:`${bin}:${process.env.PATH}`,CGQA_T3_REPRO_STATUS:'0'}});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(read(path.join(out,'manifest.json')).status,'complete');
  assert.deepEqual(fs.readdirSync(path.join(out,'repos')).sort(),held,'fetched repos are not the held-out split');
  for(const n of held.filter(n=>readRepos(CORPUS,'heldout').find(r=>r.name===n).setup==='npm'))assert(fs.existsSync(path.join(out,'logs',`setup-${n}.log`)),`no npm setup for ${n}`);
  const t=read(path.join(out,'tables.json'));assert.equal(t.split,'heldout');assert.deepEqual([...t.repos].sort(),held,'tables do not cover the held-out split');
 });
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

#!/usr/bin/env node
// lib/sandbox.ts: backend choice, the docker run flags (hermetic, against a stub docker on PATH), the
// fail-closed `require`, the venv interpreter check, and (where the image is built) a real container
// that sees no network and none of the host's files outside its mounts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sandbox from './sandbox.ts';

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok    ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-sandbox-'));
const withEnv = (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars); sandbox.resetBackend();
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } sandbox.resetBackend(); }
};

try {
  const work = path.join(tmp, 'repo'); const home = path.join(tmp, 'home'); const tool = path.join(tmp, 'tool');
  for (const d of [work, home, tool]) fs.mkdirSync(d);
  const opts = { cwd: work, env: { HOME: home, LANG: 'C.UTF-8' }, timeoutMs: 30_000, rw: [work, home], ro: [tool] };

  check('GRAPH_ASSAY_ISOLATION picks the backend; an unknown value is an error', () => {
    for (const b of sandbox.BACKENDS) withEnv({ GRAPH_ASSAY_ISOLATION: b }, () => assert.equal(sandbox.backend(), b));
    withEnv({ GRAPH_ASSAY_ISOLATION: 'chroot' }, () => assert.throws(() => sandbox.backend(), /must be one of unshare, docker, none/));
  });

  check('docker: no network, no capabilities, no new privileges, read-only root, caller uid, only the given mounts', () => {
    const a = sandbox.dockerArgs(['/opt/x/bin/tool', 'index'], opts, 'n1').join(' ');
    for (const f of ['--network none', '--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', '--init', '--rm',
      `--user ${process.getuid()}:${process.getgid()}`, `--volume ${fs.realpathSync(work)}:${fs.realpathSync(work)} `,
      `--volume ${fs.realpathSync(home)}:${fs.realpathSync(home)} `, `--volume ${fs.realpathSync(tool)}:${fs.realpathSync(tool)}:ro`,
      `--env HOME=${home}`, `${sandbox.SANDBOX_IMAGE} /opt/x/bin/tool index`]) assert.ok(a.includes(f), f);
    assert.equal((a.match(/--volume /g) ?? []).length, 3, 'no mount beyond rw + ro');
    withEnv({ GRAPH_ASSAY_SANDBOX_RO: '/opt/extra' }, () => assert.ok(sandbox.dockerArgs(['/t'], opts, 'n2').join(' ').includes('--volume /opt/extra:/opt/extra:ro')));
    assert.ok(sandbox.dockerArgs(['/t'], { ...opts, nice: true }, 'n3').join(' ').endsWith(`${sandbox.SANDBOX_IMAGE} nice -n 10 /t`));
    // a venv reached through a link (code-review-graph's venv -> venv-<lock>) runs by its real path
    fs.mkdirSync(path.join(tool, 'venv-1', 'bin'), { recursive: true }); fs.writeFileSync(path.join(tool, 'venv-1', 'bin', 'x'), '');
    fs.symlinkSync('venv-1', path.join(tool, 'venv'));
    assert.ok(sandbox.dockerArgs([path.join(tool, 'venv', 'bin', 'x'), 'a'], opts, 'n4').join(' ').endsWith(`${sandbox.SANDBOX_IMAGE} ${fs.realpathSync(tool)}/venv-1/bin/x a`));
  });

  check('docker: a timed-out run removes its container (the client dies, the container would not)', () => {
    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin); const log = path.join(tmp, 'docker.log');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${log}\n[ "$1" = run ] && sleep 5\nexit 0\n`, { mode: 0o755 });
    withEnv({ GRAPH_ASSAY_ISOLATION: 'docker', PATH: `${bin}:${process.env.PATH}` }, () => {
      const r = sandbox.run(['/t'], { ...opts, timeoutMs: 300 });
      assert.ok(r.signal || r.error, 'the stub should have timed out');
    });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    const name = lines[0].match(/--name (\S+)/)[1];
    assert.ok(lines.includes(`rm -f ${name}`), lines.join('\n'));
  });

  check('require: no isolation is a failed run, never a run with network', () => {
    withEnv({ GRAPH_ASSAY_ISOLATION: 'none' }, () => {
      const marker = path.join(tmp, 'ran');
      const r = sandbox.run(['/bin/sh', '-c', `touch ${marker}`], { ...opts, require: true });
      assert.equal(r.status, 1); assert.match(r.stderr, /refusing to run without isolation/); assert.ok(!fs.existsSync(marker));
    });
  });

  check('venvMounts: under docker a venv must use the image Python or a GRAPH_ASSAY_SANDBOX_RO prefix', () => {
    const venv = path.join(tmp, 'venv'); fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    const exe = path.join(venv, 'bin', 'tool'); fs.writeFileSync(exe, '');
    // pyvenv.cfg says /usr/bin either way: the interpreter link decides (venv over an old venv keeps its links)
    const cfg = (home) => { fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.12.3\n');
      fs.rmSync(path.join(venv, 'bin', 'python3'), { force: true }); fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'python3.12'), '');
      fs.symlinkSync(path.join(home, 'python3.12'), path.join(venv, 'bin', 'python3')); };
    withEnv({ GRAPH_ASSAY_ISOLATION: 'docker' }, () => {
      fs.rmSync(path.join(venv, 'bin', 'python3'), { force: true }); fs.symlinkSync('/usr/bin/python3.12', path.join(venv, 'bin', 'python3'));
      fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
      if (fs.existsSync('/usr/bin/python3.12')) { assert.equal(sandbox.venvMounts(exe).error, null); assert.ok(sandbox.venvMounts(exe).ro.includes(fs.realpathSync(venv))); }
      const brew = path.join(tmp, 'brew'); cfg(path.join(brew, 'bin'));
      assert.match(sandbox.venvMounts(exe).error, /no Python at .*brew/);
      withEnv({ GRAPH_ASSAY_SANDBOX_RO: brew }, () => assert.equal(sandbox.venvMounts(exe).error, null));
    });
    withEnv({ GRAPH_ASSAY_ISOLATION: 'unshare' }, () => assert.equal(sandbox.venvMounts(exe).error, null));
  });

  const built = spawnSync('docker', ['image', 'inspect', sandbox.SANDBOX_IMAGE], { stdio: 'ignore' }).status === 0;
  if (!built) console.log(`note: ${sandbox.SANDBOX_IMAGE} not built; real-container check skipped`);
  else check('docker (real): the process sees only loopback and none of the host home outside its mounts', () => {
    const secret = path.join(os.homedir(), '.cache'); // exists on any host that ran setup; never mounted
    withEnv({ GRAPH_ASSAY_ISOLATION: 'docker' }, () => {
      const r = sandbox.run(['/bin/sh', '-c', `ls /sys/class/net; test -e ${secret} && echo LEAK; echo x > ${work}/w && echo WROTE; touch ${tool}/t 2>/dev/null || echo RO`], opts);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.trim().split('\n'), ['lo', 'WROTE', 'RO']);
    });
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${n}/${n} sandbox checks`);

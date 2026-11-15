#!/usr/bin/env node
// lib/sandbox.ts: backend choice, the docker plan (hermetic, against a stub docker on PATH), the
// fail-closed `require`, the venv interpreter check, and (where the image is built) real containers
// that see no network and none of the host's files outside their mounts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sandbox from './sandbox.ts';

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`ok    ${name}`); };
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-sandbox-')));
const withEnv = (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v as string; }
  sandbox.resetBackend();
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } sandbox.resetBackend(); }
};
const plan = (argv, o, name = 'n') => { const p = sandbox.dockerPlan(argv, o, name); assert.ok(!('error' in p), JSON.stringify(p)); return p as { args: string[]; clientEnv: Record<string, string>; name: string }; };
const mounts = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));
/** A stub docker that logs each call's argv and DOCKER_HOST, and sleeps on `run` / `image inspect` when asked. */
function stubDocker(dir) {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin, { recursive: true }); const log = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
echo "host=\${DOCKER_HOST:-} secret=\${GA_SECRET:-} $*" >> ${log}
[ "$1" = run ] && [ -n "\${DOCKER_STUB_SLEEP_RUN:-}" ] && sleep "$DOCKER_STUB_SLEEP_RUN"
[ "$1" = image ] && [ -n "\${DOCKER_STUB_SLEEP_INSPECT:-}" ] && sleep "$DOCKER_STUB_SLEEP_INSPECT"
exit 0
`, { mode: 0o755 });
  return { bin, log, lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

try {
  const work = path.join(tmp, 'repo'); const home = path.join(tmp, 'home'); const tool = path.join(tmp, 'tool');
  for (const d of [work, home, tool]) fs.mkdirSync(d);
  const exe = path.join(tool, 'x'); fs.writeFileSync(exe, '', { mode: 0o755 });
  const opts = { cwd: work, env: { HOME: home, LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, timeoutMs: 30_000, rw: [work, home], ro: [] };

  check('GRAPH_ASSAY_ISOLATION picks the backend; an unknown value is an error', () => {
    for (const b of sandbox.BACKENDS) withEnv({ GRAPH_ASSAY_ISOLATION: b }, () => assert.equal(sandbox.backend(), b));
    withEnv({ GRAPH_ASSAY_ISOLATION: 'chroot' }, () => assert.throws(() => sandbox.backend(), /must be one of unshare, docker, none/));
  });

  check('docker: no network, no capabilities, no new privileges, read-only root, caller uid, bounded lifetime', () => {
    const a = plan([exe, 'index'], opts).args.join(' ');
    for (const f of ['--network none', '--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', '--init', '--rm',
      `--user ${process.getuid()}:${process.getgid()}`, `${sandbox.SANDBOX_IMAGE} timeout -k 10 35 ${exe} index`]) assert.ok(a.includes(f), f);
    assert.ok(plan([exe], { ...opts, nice: true }).args.join(' ').endsWith(`timeout -k 10 35 nice -n 10 ${exe}`));
  });

  check('docker: mounts are the rw paths, the ro paths and the executable by itself; system dirs are refused', () => {
    const m = mounts(plan([exe], { ...opts, ro: [path.join(tmp, 'lib')] }).args);
    assert.deepEqual(m, [`type=bind,source=${work},target=${work}`, `type=bind,source=${home},target=${home}`,
      `type=bind,source=${path.join(tmp, 'lib')},target=${path.join(tmp, 'lib')},readonly`, `type=bind,source=${exe},target=${exe},readonly`]);
    withEnv({ GRAPH_ASSAY_SANDBOX_RO: '/opt/extra' }, () => assert.ok(mounts(plan([exe], opts).args).includes('type=bind,source=/opt/extra,target=/opt/extra,readonly')));
    assert.match((sandbox.dockerPlan([exe], { ...opts, ro: ['/usr/bin'] }, 'n') as any).error, /refusing to mount \/usr\/bin/);
  });

  check('docker: a symlinked dir, HOME or executable is reachable at the given path inside (K1/A3)', () => {
    const link = path.join(tmp, 'link'); fs.symlinkSync(work, link);
    const exeLink = path.join(tmp, 'exe-link'); fs.symlinkSync(exe, exeLink);
    const p = plan([exeLink, '--repo', link], { ...opts, cwd: link, rw: [link, home] });
    const m = mounts(p.args);
    assert.ok(m.includes(`type=bind,source=${work},target=${link}`), m.join('\n'));
    assert.ok(m.includes(`type=bind,source=${work},target=${work}`));
    assert.ok(p.args.join(' ').includes(`--workdir ${link}`));
    assert.ok(p.args.join(' ').endsWith(`${exe} --repo ${link}`), 'runs the real executable, keeps the given args');
  });

  check('docker: a path with a comma, quote or newline is refused, never split into mount options (G1)', () => {
    const inj = path.join(tmp, 'inj,source=' + home); fs.mkdirSync(inj, { recursive: true });
    assert.match((sandbox.dockerPlan([exe], { ...opts, cwd: inj, rw: [inj] }, 'n') as any).error, /comma, quote or line break/);
    const quoted = path.join(tmp, 'q"x'); fs.mkdirSync(quoted);
    assert.match((sandbox.dockerPlan([exe], { ...opts, rw: [quoted] }, 'n') as any).error, /comma, quote or line break/);
  });

  check('docker: timeoutMs 0 or unset means no inner timeout; DOCKER_* never reach the subject (G4/G5)', () => {
    for (const t of [0, undefined]) assert.ok(!plan([exe], { ...opts, timeoutMs: t }).args.includes('timeout'), String(t));
    const p = plan([exe], { ...opts, env: { ...opts.env, DOCKER_HOST: 'tcp://subject:1' } });
    assert.ok(!p.args.includes('DOCKER_HOST')); assert.notEqual(p.clientEnv.DOCKER_HOST, 'tcp://subject:1');
  });

  check('docker: the subject env travels by name, not on the command line; PATH is explicit (A6)', () => {
    const p = plan([exe], { ...opts, env: { ...opts.env, CODEGRAPH_X: 's3cr3t' } });
    assert.ok(!p.args.join(' ').includes('s3cr3t'));
    assert.ok(p.args.join(' ').includes('--env CODEGRAPH_X') && p.args.join(' ').includes('--env PATH=/usr/bin:/bin'));
    assert.equal(p.clientEnv.CODEGRAPH_X, 's3cr3t'); assert.equal(p.clientEnv.PATH, process.env.PATH);
  });

  check('docker: a TMPDIR outside the mounts moves under the sandbox HOME (K2)', () => {
    const p = plan([exe], { ...opts, env: { ...opts.env, TMPDIR: '/var/tmp/elsewhere' } });
    assert.equal(p.clientEnv.TMPDIR, path.join(home, 'tmp')); assert.ok(fs.existsSync(path.join(home, 'tmp')));
    assert.equal(plan([exe], { ...opts, env: { ...opts.env, TMPDIR: path.join(work, 't') } }).clientEnv.TMPDIR, path.join(work, 't'));
  });

  check('docker: every docker call reaches the same daemon (DOCKER_HOST), and a timeout removes the container (K3/A1)', () => {
    const s = stubDocker(path.join(tmp, 'stub1'));
    withEnv({ GRAPH_ASSAY_ISOLATION: 'docker', PATH: `${s.bin}:${process.env.PATH}`, DOCKER_HOST: 'unix:///tmp/other.sock', DOCKER_STUB_SLEEP_RUN: '5' }, () => {
      const r = sandbox.run([exe], { ...opts, timeoutMs: 300, env: { ...opts.env, GA_SECRET: 'v' } });
      assert.ok(r.signal || r.error, 'the stub should have timed out');
    });
    const lines = s.lines(); const run = lines.find((l) => l.includes(' run '));
    const name = run.match(/--name (\S+)/)[1];
    for (const l of lines) assert.ok(l.startsWith('host=unix:///tmp/other.sock '), l);
    assert.ok(lines.some((l) => l.endsWith(`rm -f ${name}`)), lines.join('\n'));
    assert.ok(run.startsWith('host=unix:///tmp/other.sock secret=v '), 'the env value reaches the client, not its argv');
  });

  check('auto: a hung docker daemon falls back to none within the probe timeout, with a warning (A4)', () => {
    if (spawnSync('unshare', ['-rn', 'true']).status === 0) return; // unshare wins here; the docker probe is never reached
    const s = stubDocker(path.join(tmp, 'stub2'));
    withEnv({ GRAPH_ASSAY_ISOLATION: undefined, PATH: `${s.bin}:${process.env.PATH}`, DOCKER_STUB_SLEEP_INSPECT: '30' }, () => {
      const t0 = Date.now(); const err = console.error; const said = []; console.error = (m) => said.push(m);
      try { assert.equal(sandbox.backend(), 'none'); } finally { console.error = err; }
      assert.ok(Date.now() - t0 < 15_000, `probe took ${Date.now() - t0} ms`);
      assert.match(said.join('\n'), /no isolation: .*network access/);
    });
  });

  check('require: no isolation is a failed run, never a run with network', () => {
    withEnv({ GRAPH_ASSAY_ISOLATION: 'none' }, () => {
      const marker = path.join(tmp, 'ran');
      const r = sandbox.run(['/bin/sh', '-c', `touch ${marker}`], { ...opts, require: true });
      assert.equal(r.status, 1); assert.match(r.stderr, /refusing to run without isolation/); assert.ok(!fs.existsSync(marker));
    });
  });

  check('venv: the interpreter must be exactly the image Python or under a GRAPH_ASSAY_SANDBOX_RO prefix (K4/A7/K8)', () => {
    const venv = path.join(tmp, 'venv'); fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
    const script = path.join(venv, 'bin', 'tool'); fs.writeFileSync(script, '');
    const link = (to) => { fs.rmSync(path.join(venv, 'bin', 'python3'), { force: true }); fs.symlinkSync(to, path.join(venv, 'bin', 'python3')); };
    const brew = path.join(tmp, 'brew', 'bin'); fs.mkdirSync(brew, { recursive: true }); fs.writeFileSync(path.join(brew, 'python3.14'), '');
    fs.symlinkSync(path.join(tmp, 'brew'), path.join(tmp, 'brew-link'));
    if (fs.existsSync(sandbox.IMAGE_PYTHON)) { link(sandbox.IMAGE_PYTHON); assert.deepEqual(sandbox.venvOf(script), { root: venv, error: null }); }
    link('/bin/sh'); assert.match(sandbox.venvOf(script).error, /no Python at \//);
    // `python3 -m venv` links bin/python3 -> /usr/bin/python3: it resolves to python3.12 on the host,
    // but the image has no /usr/bin/python3 (V1)
    link('/usr/bin/python3'); assert.match(sandbox.venvOf(script).error, /no Python at \/usr\/bin\/python3,/);
    fs.rmSync(path.join(venv, 'bin', 'python3')); fs.symlinkSync(path.join(tmp, 'gone'), path.join(venv, 'bin', 'python3'));
    assert.match(sandbox.venvOf(script).error, /dangling|no Python at/);
    link(path.join(brew, 'python3.14')); assert.match(sandbox.venvOf(script).error, /no Python at .*brew/);
    withEnv({ GRAPH_ASSAY_SANDBOX_RO: path.join(tmp, 'brew-link') }, () => assert.equal(sandbox.venvOf(script).error, null));
    // a venv made through a symlinked dir keeps that path in its scripts: it is mounted there too (G2)
    const store = path.join(tmp, 'store'); fs.mkdirSync(path.join(store, 'v', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(store, 'v', 'pyvenv.cfg'), ''); fs.writeFileSync(path.join(store, 'v', 'bin', 'tool'), '');
    if (fs.existsSync(sandbox.IMAGE_PYTHON)) fs.symlinkSync(sandbox.IMAGE_PYTHON, path.join(store, 'v', 'bin', 'python3'));
    else fs.writeFileSync(path.join(store, 'v', 'bin', 'python3'), '');
    fs.symlinkSync(store, path.join(tmp, 'lnk'));
    const viaLink = path.join(tmp, 'lnk', 'v', 'bin', 'tool');
    assert.equal(sandbox.venvOf(viaLink).root, path.join(tmp, 'lnk', 'v'));
    assert.ok(mounts(plan([viaLink], { ...opts, venv: true }).args).includes(`type=bind,source=${path.join(store, 'v')},target=${path.join(tmp, 'lnk', 'v')},readonly`));
    // the plan mounts the venv, or refuses with the message; a missing script is left to fail as a spawn
    assert.match((sandbox.dockerPlan([script], { ...opts, venv: true }, 'n') as any).error, /no Python at .*brew/);
    assert.ok(!('error' in sandbox.dockerPlan([path.join(tmp, 'missing', 'tool')], { ...opts, venv: true }, 'n')));
  });

  check('within/confined: a link out of the root is refused; inside, missing or nested paths are fine (V3)', () => {
    const root = path.join(tmp, 'root'); fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.symlinkSync(tmp, path.join(root, 'out-link')); fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'in-link'));
    assert.equal(sandbox.within(root, path.join(root, 'sub', 'f.db')), true);
    assert.equal(sandbox.within(root, path.join(root, 'in-link', 'f.db')), true);
    assert.equal(sandbox.within(root, path.join(root, 'out-link')), false);
    assert.equal(sandbox.within(root, path.join(root, 'out-link', 'f.db')), false);
    assert.throws(() => sandbox.confined(root, path.join(root, 'out-link')), /leads outside/);
  });

  check('vet: a link, FIFO or other special file anywhere in a tool output tree is refused; plain trees pass (R3-1/R3-4)', () => {
    const t = path.join(tmp, 'vet'); fs.mkdirSync(path.join(t, 'a', 'b'), { recursive: true }); fs.writeFileSync(path.join(t, 'a', 'b', 'db'), '');
    assert.equal(sandbox.vet(t), null); assert.equal(sandbox.vet(path.join(tmp, 'no-such')), null);
    fs.symlinkSync(path.join(os.homedir(), '.bashrc'), path.join(t, 'a', 'b', 'db-shm'));
    assert.match(sandbox.vet(t), /db-shm is a link/);
    fs.rmSync(path.join(t, 'a', 'b', 'db-shm')); spawnSync('mkfifo', [path.join(t, 'a', 'fifo')]);
    if (fs.existsSync(path.join(t, 'a', 'fifo'))) assert.match(sandbox.vet(t), /fifo is not a plain file/);
    const l = path.join(tmp, 'vet-link'); fs.symlinkSync(t, l); assert.match(sandbox.vet(l), /is a link/);
    assert.equal(sandbox.vetAll(path.join(t, 'a', 'b'), path.join(tmp, 'no-such')), null);
  });

  check('within: a dangling link or a loop counts as outside (R3-3)', () => {
    const root = path.join(tmp, 'root2'); fs.mkdirSync(root);
    fs.symlinkSync(path.join(tmp, 'gone-dir'), path.join(root, 'dangling')); fs.symlinkSync('loop', path.join(root, 'loop'));
    assert.equal(sandbox.within(root, path.join(root, 'dangling')), false);
    assert.equal(sandbox.within(root, path.join(root, 'loop')), false);
    assert.equal(sandbox.within(root, path.join(root, 'new.db')), true);
  });

  check('venv reached through a link outside it: only the venv counts as mounted (N1); a CR in a path is refused (N4)', () => {
    const x = path.join(tmp, 'n1'); fs.mkdirSync(path.join(x, 'venv', 'bin'), { recursive: true }); fs.mkdirSync(path.join(x, 'home', '.local', 'py'), { recursive: true });
    fs.mkdirSync(path.join(x, 'home', '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(x, 'venv', 'pyvenv.cfg'), ''); fs.writeFileSync(path.join(x, 'venv', 'bin', 'cgr'), '');
    fs.writeFileSync(path.join(x, 'home', '.local', 'py', 'python3.12'), '');
    fs.symlinkSync(path.join(x, 'home', '.local', 'py', 'python3.12'), path.join(x, 'venv', 'bin', 'python3'));
    fs.symlinkSync(path.join(x, 'venv', 'bin', 'cgr'), path.join(x, 'home', '.local', 'bin', 'cgr'));
    assert.match(sandbox.venvOf(path.join(x, 'home', '.local', 'bin', 'cgr')).error, /no Python at .*\.local\/py\/python3\.12/);
    const cr = path.join(tmp, 'ab\r'); fs.mkdirSync(cr);
    assert.match((sandbox.dockerPlan([exe], { ...opts, rw: [cr] }, 'n') as any).error, /line break/);
  });

  const built = spawnSync('docker', ['image', 'inspect', sandbox.SANDBOX_IMAGE], { stdio: 'ignore', env: sandbox.dockerEnv() }).status === 0;
  if (!built) console.log(`note: ${sandbox.SANDBOX_IMAGE} not built; real-container checks skipped`);
  else {
    check('docker (real): only loopback, none of the host home outside the mounts, repo writable, tool read-only', () => {
      const secret = path.join(os.homedir(), '.cache'); // exists on any host that ran setup; never mounted
      withEnv({ GRAPH_ASSAY_ISOLATION: 'docker' }, () => {
        const r = sandbox.run(['/bin/sh', '-c', `ls /sys/class/net; test -e ${secret} && echo LEAK; echo x > ${work}/w && echo WROTE; touch ${tool}/t 2>/dev/null || echo RO`],
          { ...opts, ro: [tool] });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.stdout.trim().split('\n'), ['lo', 'WROTE', 'RO']);
      });
    });
    check('docker (real): a repo reached through a symlink is the repo inside (K1/A3)', () => {
      const link = path.join(tmp, 'link2'); fs.symlinkSync(work, link);
      withEnv({ GRAPH_ASSAY_ISOLATION: 'docker' }, () => {
        const r = sandbox.run(['/bin/sh', '-c', `cat ${link}/w && pwd`], { ...opts, cwd: link, rw: [link, home] });
        assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.stdout.trim().split('\n'), ['x', link]);
      });
    });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${n}/${n} sandbox checks`);

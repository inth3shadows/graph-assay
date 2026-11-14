// Labellers for the blind oracle-noise study (SPEC §9, P3). Each runs agentically with read-only
// access to one repo copy and nothing else: no MCP servers, no web, no user instructions, so no
// labeller can consult a subject under test (codegraph is an MCP server on this machine).
//
//   opus     Claude Code CLI, claude-opus-5-5 --effort high; HOME is an empty temp dir (no
//            CLAUDE.md, hooks, plugins, MCP); `--tools Read,Grep,Glob` (the only built-ins loaded). Env CLAUDE_CODE_OAUTH_TOKEN.
//   sol      Codex CLI, gpt-6.1-sol, reasoning high, `-s read-only`; every MCP server in
//            ~/.codex/config.toml disabled per run, apps / web search / image generation off,
//            AGENTS.md not loaded. Uses the existing Codex login.
//   astra    the same Codex setup with gpt-6-astra; tie-breaker on opus/sol disagreements only.
//   kimi-k3, glm-5.3
//            harness runtime (labels/harness_label.py): read-only repo tools on the LiteLLM
//            gateway; every turn's serving deployment is recorded. Env HARNESS_GATEWAY_KEY.
// probe(name) asks the labeller for its tool list and fails on anything outside its allowance.
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = process.env.CGQA_HARNESS ?? null;
// What a labeller process may see from the caller's environment: paths, locale, and the one
// credential its own CLI needs. Nothing else (other tokens, cloud keys) reaches a model's tools.
const BASE_ENV = /^(PATH|LANG|LC_[A-Z]+|TZ|TMPDIR|HOME|USER|TERM)$/;
const envWith = (...keys) => Object.fromEntries(Object.entries(process.env).filter(([k]) => BASE_ENV.test(k) || keys.includes(k)));

function sh(cmd, args, { cwd, env, input = '', timeoutMs = 900_000 }: { cwd?: string; env?: typeof process.env; input?: string; timeoutMs?: number } = {}) {
  return new Promise<any>((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    // A missing binary or a broken stdin is this labeller's failure, not the whole run's.
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, signal: null, out, err: `${err}${e.message}` }); });
    p.stdin.on('error', () => {});
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
    p.stdin.end(input);
  });
}

const codexOverrides = () => {
  const cfg = fs.readFileSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
  const servers = [...new Set([...cfg.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1]))];
  return [...servers.flatMap((s) => ['-c', `mcp_servers.${s}.enabled=false`]),
    '-c', 'features.apps=false', '-c', 'web_search=disabled', '-c', 'features.image_generation=false', '-c', 'project_doc_max_bytes=0'];
};

/** A Codex CLI labeller: reasoning high, read-only sandbox, MCP / apps / web off (codexOverrides). */
const codexLabeller = (model) => ({
  model, effort: 'high', deployment: model,
  async ask(cwd, prompt) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-label-codex-')), 'last.txt');
    try {
      const r = await sh('codex', ['exec', '-m', model, '-c', 'model_reasoning_effort=high', ...codexOverrides(),
        '-s', 'read-only', '-C', cwd, '--skip-git-repo-check', '-o', out, prompt], { cwd, env: envWith('CODEX_HOME', 'OPENAI_API_KEY') });
      const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
      return { ok: r.code === 0 && !!text, text, error: r.code === 0 ? null : (r.err || r.out).trim().slice(-300), served_by: [model] };
    } finally { fs.rmSync(path.dirname(out), { recursive: true, force: true }); }
  },
  allow: (tools) => tools.every((t) => !/^mcp__|web|image_gen|github|search_service/i.test(t)),
});

export const LABELLERS = {
  opus: {
    model: 'claude-opus-5-5', effort: 'high', deployment: 'claude-opus-5-5',
    async ask(cwd, prompt) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-label-home-'));
      try {
        const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '', LANG: 'C.UTF-8' };
        const r = await sh('claude', ['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read', 'Grep', 'Glob',
          '--output-format', 'text', prompt], { cwd, env });
        return { ok: r.code === 0, text: r.out.trim(), error: r.code === 0 ? null : (r.err || r.out).trim().slice(-300), served_by: ['claude-opus-5-5'] };
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    },
    allow: (tools) => tools.every((t) => /^(Read|Grep|Glob|TodoWrite|ToolSearch|Skill|StructuredOutput)$/i.test(t)),
  },
  sol: codexLabeller('gpt-6.1-sol'),
  astra: codexLabeller('gpt-6-astra'),
};
// The gateway deployment each must be served by (Synthetic); harness raises on any other.
const DEPLOYMENT = { 'kimi-k3': 'openai/hf:moonshotai/Kimi-K3', 'glm-5.3': 'openai/hf:zai-org/GLM-5.3' };
for (const m of ['kimi-k3', 'glm-5.3']) {
  LABELLERS[m] = {
    model: m, effort: 'default', deployment: DEPLOYMENT[m],
    async ask(cwd, prompt) {
      const pf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-label-h-')), 'prompt.txt');
      fs.writeFileSync(pf, prompt);
      try {
        if (!HARNESS) throw new Error('the harness labeller needs CGQA_HARNESS (a checkout of the harness runtime)');
        const env = { ...envWith('HARNESS_GATEWAY_KEY', 'HARNESS_GATEWAY'), PYTHONPATH: HARNESS };
        const r = await sh('python3', [path.join(here, 'harness_label.py'), m, cwd, pf, DEPLOYMENT[m]], { cwd, env });
        if (r.code !== 0) return { ok: false, text: '', error: (r.err || r.out).trim().slice(-300), served_by: [] };
        const j = JSON.parse(r.out.trim().split('\n').pop());
        return { ok: true, text: j.text.trim(), error: null, served_by: j.served_by, forced: j.forced, tokens: j.tokens, cost: j.cost };
      } finally { fs.rmSync(path.dirname(pf), { recursive: true, force: true }); }
    },
    // harness offers exactly its read-only repo tools
    allow: (tools) => tools.every((t) => /read|list|grep|find|glob|search_code|outline/i.test(t)),
  };
}

/** Ask the labeller for its tool list in an empty dir; {ok, tools, offending}. */
export async function probe(name) {
  const L = LABELLERS[name];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgqa-probe-'));
  try {
    const r = await L.ask(dir, 'List the exact names of every tool or function you can call right now, comma separated, nothing else.');
    if (!r.ok) return { ok: false, tools: [], offending: [], error: r.error };
    const tools = r.text.split(/[,\n]/).map((t) => t.trim().replace(/^functions\./, '')).filter(Boolean);
    const offending = tools.filter((t) => !L.allow([t]));
    return { ok: offending.length === 0, tools, offending };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

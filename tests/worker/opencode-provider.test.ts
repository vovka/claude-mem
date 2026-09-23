import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateOpenCodeModel } from '../../src/services/worker/OpenCodeProvider.js';
import { classifyOpenCodeError, parseOpenCodeJsonOutput } from '../../src/services/worker/opencode/output.js';
import { runOpenCode } from '../../src/services/worker/opencode/run.js';
import { buildOpenCodeSafetyConfig, buildOpenCodeSafetyEnv } from '../../src/services/worker/opencode/safety.js';

const FIXTURES = join(import.meta.dir, '../fixtures/opencode');

function fakeOpenCode(script: string): { binary: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'fake-opencode-'));
  const binary = join(cwd, 'opencode');
  writeFileSync(binary, `#!/bin/sh\n${script}\n`);
  chmodSync(binary, 0o755);
  return { binary, cwd };
}

describe('OpenCodeProvider', () => {
  it('builds a deny-all, non-sharing safety config', () => {
    const config = buildOpenCodeSafetyConfig() as any;
    expect(config.share).toBe('disabled');
    expect(config.plugin).toEqual([]);
    expect(config.mcp).toEqual({});
    expect(config.permission['*']['*']).toBe('deny');
    expect(config.agent['claude-mem-summarizer'].permission['*']['*']).toBe('deny');
    // Zen free tier 403s when tools are stripped from the request: no bare deny, no tools map.
    expect(config.permission['*']).not.toBe('deny');
    expect(config.tools).toBeUndefined();
    expect(config.agent['claude-mem-summarizer'].tools).toBeUndefined();
  });

  it('isolates OpenCode config, XDG dirs and disables ambient integrations', () => {
    const env = buildOpenCodeSafetyEnv({
      HOME: '/tmp/home',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-main-session-token',
      ANTHROPIC_API_KEY: 'secret-api-key',
      OPENCODE_CONFIG: '/tmp/unsafe-user-config.json',
      OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow' }),
      XDG_DATA_HOME: '/home/user/.local/share',
      XDG_STATE_HOME: '/home/user/.local/state',
      XDG_CACHE_HOME: '/home/user/.cache',
    });
    expect(env.HOME).toBe('/tmp/home');
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
      expect(env[key]).toContain('opencode-summarizer');
    }
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('true');
    expect(env.OPENCODE_AUTO_SHARE).toBe('false');
    expect(env.OPENCODE_DISABLE_SHARE).toBe('true');
    expect(env.OPENCODE_PURE).toBe('true');
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_PERMISSION! )['*']['*']).toBe('deny');
  });

  it('isolates Kilo (the OpenCode-fork CLI CLAUDE_MEM_OPENCODE_PATH may point at) identically', () => {
    const env = buildOpenCodeSafetyEnv({
      HOME: '/tmp/home',
      KILO_CONFIG: '/tmp/unsafe-kilo-config.jsonc',
      KILO_PERMISSION: JSON.stringify({ '*': 'allow' }),
    });
    expect(env.KILO_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(env.KILO_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(env.KILO_DISABLE_CLAUDE_CODE).toBe('true');
    expect(env.KILO_AUTO_SHARE).toBe('false');
    expect(env.KILO_DISABLE_SHARE).toBe('true');
    expect(env.KILO_PURE).toBe('true');
    expect(env.KILO_CONFIG).toBeUndefined();
    expect(JSON.parse(env.KILO_PERMISSION!)['*']['*']).toBe('deny');
    expect(JSON.parse(env.KILO_CONFIG_CONTENT!)).toEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!));
  });

  it('parses real kilo output, which prints every event twice', () => {
    const output = readFileSync(join(FIXTURES, 'kilo-run-ok.jsonl'), 'utf-8');
    expect(parseOpenCodeJsonOutput(output)).toEqual({
      content: 'OK',
      tokensUsed: 10717,
      inputTokens: 10714,
      outputTokens: 3,
    });
  });

  it('sums token usage across steps', () => {
    const output = [
      JSON.stringify({ type: 'text', part: { id: 'a', text: 'hello ' } }),
      JSON.stringify({ type: 'step_finish', part: { id: 'b', tokens: { input: 12, output: 4 } } }),
      JSON.stringify({ type: 'text', part: { id: 'c', text: 'world' } }),
      JSON.stringify({ type: 'step_finish', part: { id: 'd', tokens: { input: 20, output: 6 } } }),
    ].join('\n');
    expect(parseOpenCodeJsonOutput(output)).toEqual({
      content: 'hello world',
      tokensUsed: 42,
      inputTokens: 32,
      outputTokens: 10,
    });
  });

  it('classifies errors without false positives', () => {
    const enoent = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    const cases: Array<[string, unknown, string]> = [
      ['', enoent, 'setup_required'],
      ['Error: model not found: foo/bar', new Error('x'), 'transient'],
      ['file not found: notes.md', new Error('x'), 'transient'],
      ['request id 14290 failed', new Error('x'), 'transient'],
      ['Too many requests (HTTP 429)', new Error('x'), 'rate_limit'],
      ['rate limit exceeded', new Error('x'), 'rate_limit'],
    ];
    for (const [stderr, cause, kind] of cases) {
      expect(classifyOpenCodeError({ stderr, cause }).kind).toBe(kind);
    }
  });

  it('keeps the underlying reason in transient error messages', () => {
    const error = classifyOpenCodeError({ exitCode: 1, stderr: "OpenCode's free tier can only be used from within OpenCode", cause: new Error('x') });
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('free tier');
  });

  it('classifies a non-zero exit from the JSON error event on stdout', async () => {
    const { binary, cwd } = fakeOpenCode(`cat '${join(FIXTURES, 'kilo-run-error.jsonl')}'; exit 1`);
    const run = runOpenCode({ binary, args: [], cwd, input: '', timeoutMs: 5_000 });
    await expect(run).rejects.toMatchObject({ kind: 'auth_invalid' });
  });

  it('settles on timeout and SIGKILLs a process that ignores SIGTERM', async () => {
    const { binary, cwd } = fakeOpenCode(`echo $$ > pid; trap '' TERM; exec sleep 30`);
    const run = runOpenCode({ binary, args: [], cwd, input: '', timeoutMs: 300 });
    await expect(run).rejects.toThrow('deadline');
    const pid = Number(readFileSync(join(cwd, 'pid'), 'utf-8'));
    await Bun.sleep(3_500);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it('honors an already-aborted signal without spawning', async () => {
    const run = runOpenCode({ binary: '/nonexistent', args: [], cwd: tmpdir(), input: '', timeoutMs: 5_000, signal: AbortSignal.abort() });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects model values that look like CLI flags', () => {
    expect(() => validateOpenCodeModel('--help')).toThrow();
    expect(validateOpenCodeModel('opencode/free-model')).toBe('opencode/free-model');
    expect(validateOpenCodeModel('')).toBe('');
  });
});

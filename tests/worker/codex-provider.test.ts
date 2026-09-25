import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { classifyCodexError, parseCodexJsonOutput } from '../../src/services/worker/codex/output.js';
import {
  buildCodexConfigToml, buildCodexSafetyEnv, CODEX_HOME_DIR, prepareCodexHome,
} from '../../src/services/worker/codex/safety.js';
import { guardSharedProcessRegistrySingleton } from '../supervisor/process-registry-singleton-guard.js';

const FIXTURE = join(import.meta.dir, '../fixtures/codex/exec-ok.jsonl');

function fakeCodex(script: string): string {
  const binary = join(mkdtempSync(join(tmpdir(), 'fake-codex-')), 'codex');
  writeFileSync(binary, `#!/bin/sh\n${script}\n`);
  chmodSync(binary, 0o755);
  return binary;
}

describe('CodexProvider', () => {
  guardSharedProcessRegistrySingleton('codex-provider');

  it('strips OPENAI_/CODEX_ and Claude credentials and pins CODEX_HOME', () => {
    const env = buildCodexSafetyEnv({
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'sk-secret',
      OPENAI_BASE_URL: 'http://proxy',
      CODEX_HOME: '/home/user/.codex',
      CODEX_SANDBOX: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    });
    expect(env.HOME).toBe('/tmp/home');
    expect(Object.keys(env).filter((k) => k.startsWith('OPENAI_'))).toEqual([]);
    expect(Object.keys(env).filter((k) => k.startsWith('CODEX_'))).toEqual(['CODEX_HOME']);
    expect(env.CODEX_HOME).toBe(CODEX_HOME_DIR);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('writes a minimal config.toml', () => {
    expect(buildCodexConfigToml('gpt-5-mini')).toBe(
      'model = "gpt-5-mini"\nmodel_reasoning_effort = "low"\n\n[history]\npersistence = "none"\n',
    );
    expect(buildCodexConfigToml('')).not.toContain('model =');
    expect(() => buildCodexConfigToml('a\nb')).toThrow();
  });

  it('symlinks auth.json to the user codex home', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'user-codex-'));
    prepareCodexHome('', userHome);
    prepareCodexHome('', userHome); // idempotent
    expect(readlinkSync(join(CODEX_HOME_DIR, 'auth.json'))).toBe(join(userHome, 'auth.json'));
    expect(readFileSync(join(CODEX_HOME_DIR, 'config.toml'), 'utf-8')).toContain('persistence = "none"');
  });

  it('parses real codex exec output', () => {
    expect(parseCodexJsonOutput(readFileSync(FIXTURE, 'utf-8'))).toEqual({
      content: 'OK', tokensUsed: 13961, inputTokens: 13956, outputTokens: 5,
    });
  });

  it('classifies errors', () => {
    const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const cases: Array<[string, string, unknown, string]> = [
      ['', '', enoent, 'setup_required'],
      ['stream error: 429 Too Many Requests', '', new Error('x'), 'rate_limit'],
      ['', '{"type":"error","message":"Rate limit reached"}', new Error('x'), 'rate_limit'],
      ["You've hit your usage limit.", '', new Error('x'), 'quota_exhausted'],
      ['', '{"type":"turn.failed","error":{"message":"quota exceeded"}}', new Error('x'), 'quota_exhausted'],
      ['401 Unauthorized', '', new Error('x'), 'auth_invalid'],
      ['Reading additional input from stdin...', '', new Error('x'), 'transient'],
      ['request id 14290 failed', '', new Error('x'), 'transient'],
    ];
    for (const [stderr, stdout, cause, kind] of cases) {
      expect(classifyCodexError({ stderr, stdout, cause }).kind).toBe(kind);
    }
  });

  it('runs query() end to end through a fake codex binary', async () => {
    const args = join(mkdtempSync(join(tmpdir(), 'codex-args-')), 'args');
    const binary = fakeCodex(`echo "$@" > '${args}'; echo "$CODEX_HOME" >> '${args}'; cat >/dev/null; ` +
      `echo 'Reading additional input from stdin...' >&2; cat '${FIXTURE}'`);
    const provider = new CodexProvider(null as any, null as any);
    const config = { apiKey: 'x', model: '', binary, timeoutMs: 5_000 };
    await expect((provider as any).query([{ role: 'user', content: 'hi' }], config))
      .resolves.toMatchObject({ content: 'OK', inputTokens: 13956, outputTokens: 5 });
    const [argv, home] = readFileSync(args, 'utf-8').trim().split('\n');
    expect(argv).toStartWith('exec --json --skip-git-repo-check -s read-only -C ');
    expect(argv).toEndWith(' -');
    expect(home).toBe(CODEX_HOME_DIR);
  });

  it('classifies a non-zero exit from the error event on stdout', async () => {
    const binary = fakeCodex(`echo '{"type":"error","message":"You have hit your usage limit"}'; exit 1`);
    const provider = new CodexProvider(null as any, null as any);
    const config = { apiKey: 'x', model: '', binary, timeoutMs: 5_000 };
    await expect((provider as any).query([], config)).rejects.toMatchObject({ kind: 'quota_exhausted' });
  });
});

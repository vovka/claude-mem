import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DATA_DIR } from '../../../shared/paths.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { logger } from '../../../utils/logger.js';

const CODEX_ROOT = join(DATA_DIR, 'codex-summarizer');
export const CODEX_HOME_DIR = join(CODEX_ROOT, 'home');
export const CODEX_WORKSPACE_DIR = join(CODEX_ROOT, 'workspace');

export function buildCodexConfigToml(model: string): string {
  if (/[\0\r\n]/.test(model)) throw new Error('Invalid CLAUDE_MEM_CODEX_MODEL value');
  return [
    ...(model ? [`model = ${JSON.stringify(model)}`] : []),
    'model_reasoning_effort = "low"',
    '',
    '[history]',
    'persistence = "none"',
    '',
  ].join('\n');
}

/**
 * Creates the isolated CODEX_HOME. Never copies ~/.codex/config.toml (it may load plugins,
 * skills or a proxy); auth.json is symlinked, not copied, because Codex refreshes tokens in place.
 */
export function prepareCodexHome(model: string, userCodexHome = join(homedir(), '.codex')): void {
  for (const dir of [CODEX_HOME_DIR, CODEX_WORKSPACE_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(CODEX_HOME_DIR, 'config.toml'), buildCodexConfigToml(model), { mode: 0o600 });
  const link = join(CODEX_HOME_DIR, 'auth.json');
  const target = join(userCodexHome, 'auth.json');
  if (existsSync(link) || isDanglingLink(link)) unlinkSync(link);
  symlinkSync(target, link);
  logger.debug('SDK', 'Codex isolated home prepared', { home: CODEX_HOME_DIR });
}

function isDanglingLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export function buildCodexSafetyEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = sanitizeEnv(baseEnv);
  // Never inherit OpenAI/Codex control-plane settings (API keys, base URLs, CODEX_HOME) from the shell.
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('OPENAI_') || key.startsWith('CODEX_')) delete sanitized[key];
  }
  delete sanitized.CLAUDE_CODE_OAUTH_TOKEN;
  delete sanitized.ANTHROPIC_API_KEY;
  delete sanitized.ANTHROPIC_AUTH_TOKEN;
  return { ...sanitized, CODEX_HOME: CODEX_HOME_DIR };
}

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { estimateTokens as estimateTextTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { resolveLlmTimeoutMs } from './retry.js';
import { logger } from '../../utils/logger.js';
import { waitForSlot } from '../../supervisor/process-registry.js';
import { CliTimeoutError, runCli, serializeConversation, type CliRunResult } from './cli-run.js';
import { classifyCodexError, parseCodexJsonOutput } from './codex/output.js';
import { buildCodexSafetyEnv, CODEX_WORKSPACE_DIR, prepareCodexHome } from './codex/safety.js';

interface CodexConfig {
  apiKey: string;
  model: string;
  binary: string;
  timeoutMs: number;
}

export class CodexProvider extends OpenAICompatibleProvider<CodexConfig> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly forwardEmptyMessageResponse = true;

  protected getConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return {
      // Generic availability guard only; Codex owns ChatGPT authentication via auth.json.
      apiKey: 'codex-cli',
      model: (settings.CLAUDE_MEM_CODEX_MODEL ?? '').trim(),
      binary: settings.CLAUDE_MEM_CODEX_PATH.trim(),
      timeoutMs: resolveLlmTimeoutMs(),
    };
  }

  protected missingApiKeyError(): Error {
    return new Error('Codex CLI provider is unavailable');
  }

  protected estimateTokens(text: string): number {
    return estimateTextTokens(text);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') return null;
    return { input: result.inputTokens, output: result.outputTokens };
  }

  protected async query(
    history: ConversationMessage[],
    config: CodexConfig,
    signal?: AbortSignal,
  ): Promise<ProviderQueryResult> {
    prepareCodexHome(config.model);
    const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', CODEX_WORKSPACE_DIR, '-'];
    const input = serializeConversation(history);
    // Same pool as the Claude SDK: one codex process per slot, never one per session.
    const slot = await waitForSlot(
      () => parseInt(SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_MAX_CONCURRENT_AGENTS, 10) || 2,
      signal,
    );
    try {
      logger.debug('SDK', 'Codex query', { model: config.model || '(default)' });
      const run = await runCodex({ ...config, args, input, signal });
      return toResult(run);
    } finally {
      slot.release();
    }
  }
}

async function runCodex(
  options: CodexConfig & { args: string[]; input: string; signal?: AbortSignal },
): Promise<CliRunResult> {
  try {
    return await runCli({ ...options, cwd: CODEX_WORKSPACE_DIR, env: buildCodexSafetyEnv() });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw classifyCodexError({ stderr: error instanceof CliTimeoutError ? error.stderr : '', cause: error });
  }
}

function toResult({ stdout, stderr, code, signal }: CliRunResult): ProviderQueryResult {
  if (code !== 0 || signal) {
    const cause = new Error(signal ? `Codex killed by ${signal}` : `Codex exited with code ${code}`);
    throw classifyCodexError({ exitCode: code, stderr, stdout, cause });
  }
  return parseCodexJsonOutput(stdout);
}

export function isCodexSelected(): boolean {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER === 'codex';
}

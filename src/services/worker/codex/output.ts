import type { ProviderQueryResult } from '../OpenAICompatibleProvider.js';
import { ClassifiedProviderError, type ProviderErrorClass } from '../provider-errors.js';
import { logger } from '../../../utils/logger.js';

/** The `codex exec --json` events we read. */
interface CodexEvent {
  type?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

const ERROR_RULES: Array<[RegExp, string, ProviderErrorClass]> = [
  [/\b401\b|unauthorized|not logged in|\blogin\b/, 'Codex authentication failed (run `codex login`)', 'auth_invalid'],
  [/usage limit|quota|insufficient_quota/, 'Codex usage limit reached', 'quota_exhausted'],
  [/\b429\b|rate.?limit/, 'Codex rate limited', 'rate_limit'],
  [/context window|context_length_exceeded|maximum context/, 'Codex model context window exceeded', 'unrecoverable'],
];

export interface CodexFailureInput {
  exitCode?: number | null;
  stderr?: string;
  stdout?: string;
  cause: unknown;
}

export function classifyCodexError(input: CodexFailureInput): ClassifiedProviderError {
  if ((input.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new ClassifiedProviderError(
      'Codex executable not found. Install the Codex CLI or set CLAUDE_MEM_CODEX_PATH.',
      { kind: 'setup_required', cause: input.cause },
    );
  }
  const errors = errorMessages(input.stdout ?? '').join('\n');
  const text = `${input.stderr ?? ''}\n${errors}`.toLowerCase();
  const rule = ERROR_RULES.find(([pattern]) => pattern.test(text));
  if (rule) return new ClassifiedProviderError(rule[1], { kind: rule[2], cause: input.cause });

  const reason = errors.trim() || (input.stderr ?? '').trim() || (input.cause instanceof Error ? input.cause.message : '');
  const prefix = input.exitCode != null ? `Codex exited with code ${input.exitCode}` : 'Codex request failed';
  return new ClassifiedProviderError(prefix + (reason ? `: ${reason.slice(-500)}` : ''), { kind: 'transient', cause: input.cause });
}

export function parseCodexJsonOutput(stdout: string): ProviderQueryResult {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of stdout.split('\n').flatMap(toEvent)) {
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') content = event.item.text ?? '';
    if (event.type === 'turn.completed') {
      inputTokens += event.usage?.input_tokens ?? 0;
      outputTokens += event.usage?.output_tokens ?? 0;
    }
  }
  const tokensUsed = inputTokens + outputTokens;
  return { content: content.trim(), ...(tokensUsed > 0 ? { tokensUsed, inputTokens, outputTokens } : {}) };
}

function errorMessages(stdout: string): string[] {
  return stdout.split('\n').flatMap(toEvent)
    .filter((event) => event.type === 'error' || event.type === 'turn.failed')
    .map((event) => event.message ?? event.error?.message ?? event.type!);
}

function toEvent(line: string): CodexEvent[] {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? [value] : [];
  } catch {
    if (line.trim()) logger.warn('SDK', 'Codex stdout line was not parseable JSON', { line: line.slice(0, 200) });
    return [];
  }
}

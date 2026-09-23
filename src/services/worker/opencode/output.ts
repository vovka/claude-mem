import type { ProviderQueryResult } from '../OpenAICompatibleProvider.js';
import { ClassifiedProviderError, type ProviderErrorClass } from '../provider-errors.js';
import { logger } from '../../../utils/logger.js';

interface OpenCodeFailureInput {
  exitCode?: number | null;
  stderr?: string;
  cause: unknown;
}

/** The `opencode run --format json` / `kilo run --format json` events we read. */
interface OpenCodeEvent {
  type?: string;
  part?: { id?: string; text?: string; tokens?: { input?: number; output?: number } };
  error?: { message?: string; data?: { message?: string; statusCode?: number } };
}

const ERROR_RULES: Array<[RegExp, string, ProviderErrorClass]> = [
  [/\bhttp 401\b|unauthorized|authentication|invalid api key|api key not valid/,
    'OpenCode provider authentication failed', 'auth_invalid'],
  [/\bhttp 429\b|rate.?limit/, 'OpenCode provider rate limited', 'rate_limit'],
  [/quota exceeded|quota_exhausted|insufficient credits|allowance exhausted/,
    'OpenCode provider quota exhausted', 'quota_exhausted'],
  [/context window|prompt is too long|maximum context/, 'OpenCode model context window exceeded', 'unrecoverable'],
];

export function classifyOpenCodeError(input: OpenCodeFailureInput): ClassifiedProviderError {
  const stderr = input.stderr ?? '';
  const lower = stderr.toLowerCase();
  if ((input.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new ClassifiedProviderError(
      "OpenCode executable not found. Install OpenCode or set CLAUDE_MEM_OPENCODE_PATH.",
      { kind: 'setup_required', cause: input.cause },
    );
  }
  const rule = ERROR_RULES.find(([pattern]) => pattern.test(lower));
  if (rule) return new ClassifiedProviderError(rule[1], { kind: rule[2], cause: input.cause });

  const reason = stderr.trim() || (input.cause instanceof Error ? input.cause.message : '');
  const detail = reason ? `: ${reason.slice(-500)}` : '';
  return new ClassifiedProviderError(
    (input.exitCode !== undefined && input.exitCode !== null
      ? `OpenCode exited with code ${input.exitCode}`
      : 'OpenCode request failed') + detail,
    { kind: 'transient', cause: input.cause },
  );
}

export function parseOpenCodeJsonOutput(stdout: string): ProviderQueryResult {
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of uniqueEvents(stdout)) {
    if (event.type === 'error') throw new Error(errorMessage(event));
    if (event.type === 'text') content += event.part?.text ?? '';
    if (event.type === 'step_finish') {
      inputTokens += event.part?.tokens?.input ?? 0;
      outputTokens += event.part?.tokens?.output ?? 0;
    }
  }
  const tokensUsed = inputTokens + outputTokens;
  return {
    content: content.trim(),
    ...(tokensUsed > 0 ? { tokensUsed, inputTokens, outputTokens } : {}),
  };
}

// Kilo prints every event twice with the same part id, so keep the first of each.
function uniqueEvents(stdout: string): OpenCodeEvent[] {
  const seen = new Set<string>();
  return stdout.split('\n').flatMap(toEvent).filter((event) => {
    const id = event.part?.id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function toEvent(line: string): OpenCodeEvent[] {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? [value] : [];
  } catch {
    if (line.trim()) logger.warn('SDK', 'OpenCode stdout line was not parseable JSON', { line: line.slice(0, 200) });
    return [];
  }
}

function errorMessage({ error }: OpenCodeEvent): string {
  const message = error?.data?.message ?? error?.message ?? 'Unknown OpenCode error';
  const status = error?.data?.statusCode;
  return status ? `${message} (HTTP ${status})` : message;
}

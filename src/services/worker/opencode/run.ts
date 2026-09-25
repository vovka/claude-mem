import type { ProviderQueryResult } from '../OpenAICompatibleProvider.js';
import { runCli, CliTimeoutError, type CliRunResult } from '../cli-run.js';
import { classifyOpenCodeError, parseOpenCodeJsonOutput } from './output.js';
import { buildOpenCodeSafetyEnv } from './safety.js';
import { logger } from '../../../utils/logger.js';

export interface OpenCodeRunOptions {
  binary: string;
  args: string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs one `opencode run` and settles on exit, timeout or abort, whichever comes first. */
export async function runOpenCode(options: OpenCodeRunOptions): Promise<ProviderQueryResult> {
  let run: CliRunResult;
  try {
    run = await runCli({ ...options, env: buildOpenCodeSafetyEnv() });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    const stderr = error instanceof CliTimeoutError ? error.stderr : '';
    throw classifyOpenCodeError({ stderr, cause: error });
  }
  return toResult(run);
}

function toResult({ stdout, stderr, code, signal }: CliRunResult): ProviderQueryResult {
  if (code === 0 && !signal) {
    try { return parseOpenCodeJsonOutput(stdout); } catch (error) { throw classifyOpenCodeError({ exitCode: 0, stderr, cause: error }); }
  }
  // OpenCode reports provider errors (401, 403, 429, ...) as a JSON event on stdout, not stderr.
  let cause = new Error(signal ? `OpenCode killed by ${signal}` : `OpenCode exited with code ${code}`);
  try { parseOpenCodeJsonOutput(stdout); } catch (error) { cause = error as Error; stderr += `\n${cause.message}`; }
  logger.debug('SDK', 'OpenCode run failed', { code, signal });
  throw classifyOpenCodeError({ exitCode: code, stderr, cause });
}

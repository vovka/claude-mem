import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { ProviderQueryResult } from '../OpenAICompatibleProvider.js';
import { classifyOpenCodeError, parseOpenCodeJsonOutput } from './output.js';
import { buildOpenCodeSafetyEnv } from './safety.js';
import { logger } from '../../../utils/logger.js';

// How long a SIGTERM'd OpenCode process gets before SIGKILL.
const KILL_GRACE_MS = 3_000;

export interface OpenCodeRunOptions {
  binary: string;
  args: string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

type Settle = (error: Error | null, result?: ProviderQueryResult) => void;

/** Runs one `opencode run` and settles on exit, timeout or abort, whichever comes first. */
export function runOpenCode(options: OpenCodeRunOptions): Promise<ProviderQueryResult> {
  return new Promise((resolve, reject) => {
    new OpenCodeRun(options, (error, result) => (error ? reject(error) : resolve(result!))).start();
  });
}

class OpenCodeRun {
  private child!: ChildProcessWithoutNullStreams;
  private stdout = '';
  private stderr = '';
  private settled = false;
  private timer?: NodeJS.Timeout;
  private readonly onAbort = () => this.stop(abortError());

  constructor(private readonly options: OpenCodeRunOptions, private readonly done: Settle) {}

  start(): void {
    if (this.options.signal?.aborted) return this.settle(abortError());
    this.child = spawn(this.options.binary, this.options.args, {
      cwd: this.options.cwd,
      env: buildOpenCodeSafetyEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.listen();
    this.child.stdin.end(this.options.input);
  }

  private listen(): void {
    const { child, options } = this;
    child.stdout.on('data', (chunk: Buffer) => { this.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString(); });
    child.stdin.on('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') this.fail(error); });
    child.on('error', (error) => this.fail(error));
    child.on('close', (code, signal) => this.onClose(code, signal));
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timer = setTimeout(() => this.onTimeout(), options.timeoutMs);
    this.timer.unref?.();
  }

  private onTimeout(): void {
    logger.warn('SDK', `OpenCode timed out after ${this.options.timeoutMs}ms, sending SIGTERM/SIGKILL`);
    this.stop(classifyOpenCodeError({
      stderr: this.stderr,
      cause: new Error(`OpenCode exceeded the ${this.options.timeoutMs}ms inference deadline`),
    }));
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (code === 0 && !signal) return this.succeed();
    // OpenCode reports provider errors (401, 403, 429, ...) as a JSON event on stdout, not stderr.
    let cause = new Error(signal ? `OpenCode killed by ${signal}` : `OpenCode exited with code ${code}`);
    try { parseOpenCodeJsonOutput(this.stdout); } catch (error) { cause = error as Error; this.stderr += `\n${cause.message}`; }
    this.fail(cause, code);
  }

  private succeed(): void {
    try { this.settle(null, parseOpenCodeJsonOutput(this.stdout)); } catch (error) { this.fail(error, 0); }
  }

  private fail(cause: unknown, exitCode?: number | null): void {
    this.settle(classifyOpenCodeError({ exitCode, stderr: this.stderr, cause }));
  }

  /** Settles right away; the process may ignore SIGTERM, so SIGKILL follows after a grace period. */
  private stop(error: Error): void {
    this.settle(error);
    this.child.kill('SIGTERM');
    setTimeout(() => this.child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  }

  private settle(error: Error | null, result?: ProviderQueryResult): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.done(error, result);
  }
}

function abortError(): Error {
  const error = new Error('OpenCode query aborted');
  error.name = 'AbortError';
  return error;
}

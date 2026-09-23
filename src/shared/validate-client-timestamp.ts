/**
 * Validates a client-supplied original-event time (transcript backfill): an ISO
 * string or epoch ms between 2020-01-01 and 5 minutes from now. Returns epoch ms,
 * or undefined so callers fall back to Date.now().
 */

const MIN_EPOCH_MS = Date.parse('2020-01-01T00:00:00Z');
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function validateClientTimestamp(value: unknown): number | undefined {
  const epoch = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return epoch >= MIN_EPOCH_MS && epoch <= Date.now() + MAX_FUTURE_SKEW_MS ? epoch : undefined;
}

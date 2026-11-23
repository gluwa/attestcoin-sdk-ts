/**
 * Helpers for reasoning about proof lookups that `decode-blocks` had to skip.
 *
 * Kept next to the script that owns this policy rather than in `src/utils`, so
 * it stays out of the SDK's public surface while remaining unit-testable.
 */

/**
 * The reason a transaction's proof could not be fetched, for the cases benign
 * enough to skip the transaction rather than fail the run.
 */
export type ProofSkipReason = 'EmptyBlockTxProof' | 'BlockNotReady' | 'BlockNotOnSourceChain';

/**
 * `encode-blocks` writes each transaction as
 * `<pathToStore>/<blockNumber>/<txHash>.txt`, so the block a transaction came
 * from can be read straight off its path.
 *
 * @param pathToTxn - path of the encoded transaction file
 * @returns the block number, or `null` if the path does not carry one
 */
export function blockNumberFromPath(pathToTxn: string): number | null {
  const pathComponents = pathToTxn.replace(/\.txt$/, '').split('/');
  const parent = pathComponents[pathComponents.length - 2];
  if (parent === undefined || !/^\d+$/.test(parent)) {
    return null;
  }

  return Number(parent);
}

/**
 * Whether a skipped proof lookup is one we expect rather than a symptom of a
 * broken prover.
 *
 * Attestation trails the source chain by a few minutes, so a block encoded
 * moments ago legitimately has no proof yet — this workflow encodes the newest
 * blocks it can find, so that is the common case, not the exception. A block at
 * or below the attested height is a different matter: the proof should exist,
 * and its absence means the prover is not doing its job.
 *
 * @param reason - why the lookup was skipped
 * @param blockNumber - source-chain block the transaction came from, if known
 * @param attestedHeight - latest attested height for that chain, if known
 *
 * @example
 * ```ts
 * // block 100 with attestation at 90: not attested yet, skipping is expected
 * isExpectedProofSkip('BlockNotOnSourceChain', 100, 90); // true
 * // block 80 with attestation at 90: the prover should have had this proof
 * isExpectedProofSkip('BlockNotOnSourceChain', 80, 90); // false
 * ```
 */
export function isExpectedProofSkip(
  reason: ProofSkipReason,
  blockNumber: number | null,
  attestedHeight: number | null,
): boolean {
  // a block with no transactions has no tx proof to verify, at any height
  if (reason === 'EmptyBlockTxProof') {
    return true;
  }

  // without both heights there is nothing to compare, so give the prover the
  // benefit of the doubt rather than failing runs on a missing data point
  if (blockNumber === null || attestedHeight === null) {
    return true;
  }

  return blockNumber > attestedHeight;
}

/**
 * Picks at most `limit` items, spread evenly across `items` rather than taken
 * from the front, so a capped run still samples every block it encoded instead
 * of exhausting itself on the oldest one.
 *
 * @param items - the full, sorted work list
 * @param limit - maximum items to keep; `0` or less keeps everything
 *
 * @example
 * ```ts
 * sampleEvenly(['a', 'b', 'c', 'd'], 2); // ['a', 'c']
 * ```
 */
export function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (limit <= 0 || items.length <= limit) {
    return items;
  }

  const stride = items.length / limit;
  const sampled: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    sampled.push(items[Math.floor(i * stride)]);
  }

  return sampled;
}

/** How long to wait between proof lookups while the archiver catches up. */
export const ARCHIVER_RETRY_INTERVAL_MS = 5_000;

/**
 * How long to keep waiting on a lagging archiver before failing the run. A
 * healthy archiver closes the gap well within this, so hitting the cap means it
 * is stuck rather than slow, and that should still surface as a failure.
 */
export const ARCHIVER_MAX_WAIT_MS = 2 * 60_000;

/**
 * True when the prover rejected a lookup because the block range is attested
 * but the archiver has not finished storing it yet (HTTP 422,
 * `code: 'ArchiverCatchingUp'`). The prover flags this as retriable: the proof
 * will exist shortly, so the lookup should be repeated rather than skipped.
 *
 * @param error - the value caught from the proof lookup
 */
export function isArchiverCatchingUp(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: { code?: unknown } } })?.response;
  return response?.status === 422 && response.data?.code === 'ArchiverCatchingUp';
}

export interface ArchiverRetryOptions {
  /** delay between attempts; defaults to {@link ARCHIVER_RETRY_INTERVAL_MS} */
  intervalMs?: number;
  /** give up once this much time has been spent waiting; defaults to {@link ARCHIVER_MAX_WAIT_MS} */
  maxWaitMs?: number;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `operation`, repeating it every `intervalMs` for as long as it fails with
 * {@link isArchiverCatchingUp}, up to `maxWaitMs` of total waiting. Any other
 * error, or the archiver still lagging once the budget is spent, is thrown.
 *
 * @param label - name used in the retry log line
 * @param operation - the (idempotent) lookup to run
 * @param opts - see {@link ArchiverRetryOptions}
 *
 * @example
 * ```ts
 * const response = await retryWhileArchiverCatchingUp('proof-by-tx 0xabc', () => axios.get(url));
 * ```
 */
export async function retryWhileArchiverCatchingUp<T>(
  label: string,
  operation: () => Promise<T>,
  opts: ArchiverRetryOptions = {},
): Promise<T> {
  const {
    intervalMs = ARCHIVER_RETRY_INTERVAL_MS,
    maxWaitMs = ARCHIVER_MAX_WAIT_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = opts;

  let waitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await operation();
      if (waitedMs > 0) {
        console.log(`    ... archiver caught up for ${label} after ~${waitedMs / 1000}s`);
      }
      return result;
    } catch (error) {
      if (!isArchiverCatchingUp(error) || waitedMs + intervalMs > maxWaitMs) {
        throw error;
      }
      const detail = (error as { response?: { data?: { message?: unknown } } }).response?.data?.message;
      console.warn(
        `    ... archiver catching up on ${label} (attempt ${attempt}, waited ~${waitedMs / 1000}s): ${detail ?? 'no detail'}; retrying in ${intervalMs / 1000}s`,
      );
      await sleep(intervalMs);
      waitedMs += intervalMs;
    }
  }
}

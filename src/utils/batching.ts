/**
 * Split `items` into consecutive sub-batches of at most `maxBatchSize`, preserving
 * order. `splitIntoBatches(xs, n).flat()` always reconstructs `xs`.
 *
 * Why this exists: the built-in (Transformers.js / onnxruntime-web) embedder runs
 * one forward pass per call, and embedding a whole note's chunks in a single
 * `[N, seqLen]` pass costs roughly `N * heads * seqLen^2 * 4 bytes` for the
 * attention buffer. A large note (e.g. a long config/README) chunks into a big
 * array of near-max-length chunks, so one pass can overrun the wasm32 ~4GB
 * address space and abort the runtime, which surfaces as a bare-number throw (the
 * `8934496`-style error). The cap is independent of host RAM, so a powerful
 * machine fails just the same. Capping N per pass keeps peak memory bounded.
 * See docs/builtin-embedding-batch-cap-spec.md for the measured thresholds.
 */
export function splitIntoBatches<T>(items: T[], maxBatchSize: number): T[][] {
    if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
        throw new Error(
            `maxBatchSize must be a positive integer, got ${maxBatchSize}`
        );
    }

    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += maxBatchSize) {
        batches.push(items.slice(i, i + maxBatchSize));
    }
    return batches;
}

export interface BudgetLimits {
    /** Maximum number of items in one batch. */
    maxItems: number;
    /** Maximum summed cost of the items in one batch. */
    maxCost: number;
}

/**
 * Split `items` into consecutive batches, preserving order, so that each batch
 * holds at most `maxItems` items and its summed `costs` stay within `maxCost`.
 * `splitByBudget(xs, costs, limits).flat()` always reconstructs `xs`.
 *
 * Throws if a single item's cost exceeds `maxCost`: such an item can never fit
 * in any batch, and sending it anyway would only fail later at the server.
 *
 * Why this exists: a remote embeddings endpoint caps one request in two ways at
 * once — a count of inputs and a total of tokens (OpenAI: 2048 inputs and
 * 300,000 tokens). A long note chunks into many near-cap chunks, so sending a
 * whole note as one request overran the token cap and the note failed with a
 * 400 on every attempt. See docs/openai-request-cap-spec.md.
 */
export function splitByBudget<T>(
    items: T[],
    costs: number[],
    limits: BudgetLimits
): T[][] {
    if (!Number.isInteger(limits.maxItems) || limits.maxItems <= 0) {
        throw new Error(
            `maxItems must be a positive integer, got ${limits.maxItems}`
        );
    }
    if (!(limits.maxCost > 0)) {
        throw new Error(`maxCost must be positive, got ${limits.maxCost}`);
    }
    if (costs.length !== items.length) {
        throw new Error(
            `costs (${costs.length}) must match items (${items.length})`
        );
    }

    const batches: T[][] = [];
    let current: T[] = [];
    let currentCost = 0;

    for (let i = 0; i < items.length; i++) {
        const cost = costs[i];
        if (cost > limits.maxCost) {
            throw new Error(
                `Item ${i} costs ${cost}, above the per-batch limit of ${limits.maxCost}; it cannot be sent`
            );
        }
        const wouldOverflow =
            current.length >= limits.maxItems ||
            currentCost + cost > limits.maxCost;
        if (wouldOverflow && current.length > 0) {
            batches.push(current);
            current = [];
            currentCost = 0;
        }
        current.push(items[i]);
        currentCost += cost;
    }
    if (current.length > 0) {
        batches.push(current);
    }
    return batches;
}

/**
 * Embed `items` through `embedBatch` in `maxBatchSize`-bounded sub-batches, run
 * **sequentially** (so peak memory is one sub-batch, not the whole input), and
 * concatenate the per-sub-batch embeddings back in input order. A rejection from
 * `embedBatch` propagates unchanged so callers can normalize/handle it. This is
 * the orchestration behind `handleEmbedBatch`; see `splitIntoBatches` for why the
 * cap matters.
 */
export async function embedInBatches<T>(
    items: T[],
    maxBatchSize: number,
    embedBatch: (batch: T[]) => Promise<number[][]>
): Promise<number[][]> {
    const result: number[][] = [];
    for (const batch of splitIntoBatches(items, maxBatchSize)) {
        const embeddings = await embedBatch(batch);
        result.push(...embeddings);
    }
    return result;
}

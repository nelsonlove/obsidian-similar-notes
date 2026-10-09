import { beforeEach, describe, expect, test, vi } from "vitest";

// The client is the only thing that touches the network; stub it so the
// provider's request planning can be observed call by call.
const embedTexts = vi.fn();
const embedText = vi.fn();
vi.mock("@/adapter/openai", () => ({
    OpenAIClient: class {
        embedText = embedText;
        embedTexts = embedTexts;
        setBaseUrl = vi.fn();
        setApiKey = vi.fn();
    },
    UsageTracker: class {
        trackUsage = vi.fn();
    },
}));

import {
    MAX_ESTIMATED_TOKENS_PER_REQUEST,
    MAX_INPUTS_PER_REQUEST,
    OpenAIEmbeddingProvider,
} from "../OpenAIEmbeddingProvider";

const DIM = 3;

async function loadedProvider(maxTokens?: number): Promise<OpenAIEmbeddingProvider> {
    embedText.mockResolvedValue({ embedding: [0, 0, 1] });
    const provider = new OpenAIEmbeddingProvider({
        url: "https://api.openai.com/v1",
        apiKey: "test",
        model: "text-embedding-3-small",
        maxTokens,
    });
    await provider.loadModel("text-embedding-3-small");
    return provider;
}

// Each input embeds to [index, 0, 0] so a reordering is visible.
function echoBatch(startIndex: { value: number }) {
    return async (_model: string, texts: string[]) => {
        const embeddings = texts.map((_t, i) => [startIndex.value + i, 0, 0]);
        startIndex.value += texts.length;
        return {
            embeddings,
            usage: { prompt_tokens: texts.length * 10, total_tokens: texts.length * 10 },
        };
    };
}

beforeEach(() => {
    embedTexts.mockReset();
    embedText.mockReset();
});

describe("OpenAIEmbeddingProvider.embedTexts: one request per budget, never one per note (openai-request-cap spec)", () => {
    test("a small note goes in one request", async () => {
        const provider = await loadedProvider();
        embedTexts.mockImplementation(echoBatch({ value: 0 }));

        const result = await provider.embedTexts(["a", "b", "c"]);

        expect(embedTexts).toHaveBeenCalledTimes(1);
        expect(result).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    });

    test("splits by input count at the 2048-input cap, in order", async () => {
        const provider = await loadedProvider();
        embedTexts.mockImplementation(echoBatch({ value: 0 }));
        const texts = Array.from({ length: MAX_INPUTS_PER_REQUEST + 1 }, (_, i) => `t${i}`);

        const result = await provider.embedTexts(texts);

        expect(embedTexts).toHaveBeenCalledTimes(2);
        expect(embedTexts.mock.calls[0][1]).toHaveLength(MAX_INPUTS_PER_REQUEST);
        expect(embedTexts.mock.calls[1][1]).toHaveLength(1);
        expect(result).toHaveLength(texts.length);
        expect(result[MAX_INPUTS_PER_REQUEST]).toEqual([MAX_INPUTS_PER_REQUEST, 0, 0]);
    });

    test("splits by estimated tokens well under the 300k hard cap", async () => {
        const provider = await loadedProvider();
        embedTexts.mockImplementation(echoBatch({ value: 0 }));
        // ASCII: ~4 chars per estimated token. 2000 chars ≈ 500 tokens each;
        // 300 of them ≈ 150k estimated tokens → must become 2 requests.
        const chunk = "x".repeat(2000);
        const texts = Array.from({ length: 300 }, () => chunk);

        await provider.embedTexts(texts);

        expect(embedTexts.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const call of embedTexts.mock.calls) {
            const estimated = (call[1] as string[]).reduce((n, t) => n + Math.ceil(t.length / 4), 0);
            expect(estimated).toBeLessThanOrEqual(MAX_ESTIMATED_TOKENS_PER_REQUEST);
        }
        const sent = embedTexts.mock.calls.reduce((n, call) => n + (call[1] as string[]).length, 0);
        expect(sent).toBe(300);
    });

    test("refuses a single input above the model's input limit before sending anything", async () => {
        const provider = await loadedProvider(100);
        embedTexts.mockImplementation(echoBatch({ value: 0 }));

        await expect(
            provider.embedTexts(["fine", "y".repeat(401), "fine"])
        ).rejects.toThrow(/Input 2 of 3 is ~101 tokens, above the 100-token input limit; nothing was sent/);
        expect(embedTexts).not.toHaveBeenCalled();
    });

    test("sums usage across the requests of one note", async () => {
        const provider = await loadedProvider();
        embedTexts.mockImplementation(echoBatch({ value: 0 }));
        const tracker = (provider as unknown as { usageTracker: { trackUsage: ReturnType<typeof vi.fn> } | null });
        tracker.usageTracker = { trackUsage: vi.fn() };
        const texts = Array.from({ length: MAX_INPUTS_PER_REQUEST + 1 }, (_, i) => `t${i}`);

        await provider.embedTexts(texts);

        expect(tracker.usageTracker.trackUsage).toHaveBeenCalledTimes(1);
        expect(tracker.usageTracker.trackUsage).toHaveBeenCalledWith(texts.length * 10, texts.length * 10);
    });

    test("stops at the first failed request and propagates the error", async () => {
        const provider = await loadedProvider();
        embedTexts
            .mockImplementationOnce(echoBatch({ value: 0 }))
            .mockRejectedValueOnce(new Error("Failed to generate embeddings: 400"));
        const texts = Array.from({ length: MAX_INPUTS_PER_REQUEST * 3 }, (_, i) => `t${i}`);

        await expect(provider.embedTexts(texts)).rejects.toThrow(/400/);
        expect(embedTexts).toHaveBeenCalledTimes(2);
    });

    test("an empty input makes no request", async () => {
        const provider = await loadedProvider();
        expect(await provider.embedTexts([])).toEqual([]);
        expect(embedTexts).not.toHaveBeenCalled();
    });

    test("vector size comes from the load-time probe", async () => {
        const provider = await loadedProvider();
        expect(provider.getVectorSize()).toBe(DIM);
    });
});

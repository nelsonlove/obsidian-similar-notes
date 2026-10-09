import { beforeEach, describe, expect, test, vi } from "vitest";

const requestUrl = vi.fn();
vi.mock("obsidian", () => ({ requestUrl: (...args: unknown[]) => requestUrl(...args) }));

import { GeminiClient } from "../GeminiClient";

// Placeholders, never real keys.
const KEY_A = "AIza-placeholder-a";
const KEY_B = "AIza-placeholder-b";

type Call = { headers: Record<string, string> };

beforeEach(() => {
    requestUrl.mockReset();
    requestUrl.mockResolvedValue({ status: 200, json: { embedding: { values: [0, 1] } } });
});

describe("GeminiClient: the API key is resolved on every request", () => {
    test("a function key source is called per request, so a rotated secret takes effect at once", async () => {
        let current = KEY_A;
        const client = new GeminiClient(() => current);

        await client.embedText("m", "x");
        current = KEY_B;
        await client.embedText("m", "y");

        const keys = requestUrl.mock.calls.map((c) => (c[0] as Call).headers["x-goog-api-key"]);
        expect(keys).toEqual([KEY_A, KEY_B]);
    });

    test("a resolver that yields nothing sends no key header", async () => {
        const client = new GeminiClient(() => undefined);
        await client.embedText("m", "x");
        expect((requestUrl.mock.calls[0][0] as Call).headers).not.toHaveProperty("x-goog-api-key");
        expect(client.hasApiKey()).toBe(false);
    });

    test("a plain string key still works", async () => {
        const client = new GeminiClient(KEY_A);
        await client.embedText("m", "x");
        expect((requestUrl.mock.calls[0][0] as Call).headers["x-goog-api-key"]).toBe(KEY_A);
        expect(client.hasApiKey()).toBe(true);
    });
});

import { beforeEach, describe, expect, test, vi } from "vitest";

const requestUrl = vi.fn();
vi.mock("obsidian", () => ({ requestUrl: (...args: unknown[]) => requestUrl(...args) }));

import { OpenAIClient } from "../OpenAIClient";

// Placeholders, never real keys.
const KEY_A = "sk-placeholder-a";
const KEY_B = "sk-placeholder-b";

function okResponse() {
    return {
        status: 200,
        json: { data: [{ index: 0, embedding: [0, 1] }], usage: { prompt_tokens: 1, total_tokens: 1 } },
    };
}

type Call = { headers: Record<string, string> };

beforeEach(() => {
    requestUrl.mockReset();
    requestUrl.mockResolvedValue(okResponse());
});

describe("OpenAIClient: the API key is resolved on every request", () => {
    test("a function key source is called per request, so a rotated secret takes effect at once", async () => {
        let current = KEY_A;
        const client = new OpenAIClient("https://example.test/v1", () => current);

        await client.embedText("m", "x");
        current = KEY_B;
        await client.embedTexts("m", ["x"]);

        const auth = requestUrl.mock.calls.map((c) => (c[0] as Call).headers.Authorization);
        expect(auth).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    });

    test("a resolver that yields nothing sends no Authorization header", async () => {
        const client = new OpenAIClient("https://example.test/v1", () => undefined);
        await client.embedText("m", "x");
        expect((requestUrl.mock.calls[0][0] as Call).headers).not.toHaveProperty("Authorization");
        expect(client.hasApiKey()).toBe(false);
    });

    test("a plain string key still works", async () => {
        const client = new OpenAIClient("https://example.test/v1", KEY_A);
        await client.embedText("m", "x");
        expect((requestUrl.mock.calls[0][0] as Call).headers.Authorization).toBe(`Bearer ${KEY_A}`);
        expect(client.hasApiKey()).toBe(true);
    });
});

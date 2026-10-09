import { beforeEach, describe, expect, test } from "vitest";
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import type { NoteChunkDTO } from "@/domain/model/NoteChunkDTO";
import { OramaWorker } from "../OramaDatabase";

// OramaWorker hashes paths with crypto.subtle; jsdom does not provide it.
if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

const DIM = 4;
let vaultCounter = 0;

function unit(x: number, y: number, z: number, w: number): number[] {
    const n = Math.hypot(x, y, z, w);
    return [x / n, y / n, z / n, w / n];
}

function dto(overrides: Partial<NoteChunkDTO>): NoteChunkDTO {
    return {
        path: "note.md",
        title: "note",
        content: "text",
        chunkIndex: 0,
        totalChunks: 1,
        embedding: unit(1, 0, 0, 0),
        ...overrides,
    };
}

async function freshWorker(): Promise<{ worker: OramaWorker; vaultId: string }> {
    const vaultId = `vault-${++vaultCounter}`;
    const worker = new OramaWorker();
    await worker.init(DIM, vaultId, false);
    return { worker, vaultId };
}

describe("OramaWorker: slim index, chunk text read back from IndexedDB", () => {
    let worker: OramaWorker;
    let vaultId: string;

    beforeEach(async () => {
        ({ worker, vaultId } = await freshWorker());
    });

    test("a hit carries its own chunk text and index, read from storage", async () => {
        await worker.putMulti([
            dto({ path: "a.md", title: "a", chunkIndex: 0, totalChunks: 2, content: "a-first", embedding: unit(1, 0, 0, 0) }),
            dto({ path: "a.md", title: "a", chunkIndex: 1, totalChunks: 2, content: "a-second", embedding: unit(0, 1, 0, 0) }),
            dto({ path: "b.md", title: "b", content: "b-only", embedding: unit(0, 0, 1, 0) }),
        ]);

        const hits = await worker.findSimilarChunks(unit(0, 1, 0, 0), 2);

        expect(hits[0].chunk).toMatchObject({
            path: "a.md",
            chunkIndex: 1,
            totalChunks: 2,
            content: "a-second",
        });
        expect(hits[0].score).toBeCloseTo(1, 5);
        // Hits carry no embedding (Orama nulls the vector on hits; it never
        // reached callers before either) — getByPath is the way to it.
        expect(hits[0].chunk.embedding).toEqual([]);
    });

    test("excludePaths filters hits", async () => {
        await worker.putMulti([
            dto({ path: "a.md", embedding: unit(1, 0, 0, 0) }),
            dto({ path: "b.md", embedding: unit(0.9, 0.1, 0, 0) }),
        ]);
        const hits = await worker.findSimilarChunks(unit(1, 0, 0, 0), 5, 0, ["a.md"]);
        expect(hits.map((h) => h.chunk.path)).toEqual(["b.md"]);
    });

    test("removeByPath clears the vector so the note no longer matches", async () => {
        await worker.putMulti([
            dto({ path: "a.md", embedding: unit(1, 0, 0, 0) }),
            dto({ path: "b.md", embedding: unit(0, 1, 0, 0) }),
        ]);
        expect(await worker.removeByPath("a.md")).toBe(true);
        expect(worker.count()).toBe(1);

        const hits = await worker.findSimilarChunks(unit(1, 0, 0, 0), 5);
        expect(hits.map((h) => h.chunk.path)).toEqual(["b.md"]);
    });

    test("renamePath keeps the embedding and the text under the new path", async () => {
        await worker.put(dto({ path: "old.md", content: "kept", embedding: unit(1, 0, 0, 0) }));
        expect(await worker.renamePath("old.md", "new.md")).toBe(true);

        const hits = await worker.findSimilarChunks(unit(1, 0, 0, 0), 5);
        expect(hits).toHaveLength(1);
        expect(hits[0].chunk).toMatchObject({ path: "new.md", content: "kept" });
        expect(await worker.getByPath("old.md")).toEqual([]);
    });

    test("getByPath returns the full chunks from storage, embeddings included", async () => {
        await worker.put(dto({ path: "a.md", content: "full", embedding: unit(0, 0, 0, 1) }));
        const chunks = await worker.getByPath("a.md");
        expect(chunks).toHaveLength(1);
        expect(chunks[0].content).toBe("full");
        expect(chunks[0].embedding.map((v) => Math.round(v))).toEqual([0, 0, 0, 1]);
    });

    test("a restart rebuilds the index from IndexedDB and still resolves text", async () => {
        await worker.putMulti([
            dto({ path: "a.md", content: "persisted", embedding: unit(1, 0, 0, 0) }),
        ]);

        const reloaded = new OramaWorker();
        await reloaded.init(DIM, vaultId, true);
        expect(reloaded.count()).toBe(1);

        const hits = await reloaded.findSimilarChunks(unit(1, 0, 0, 0), 5);
        expect(hits[0].chunk).toMatchObject({ path: "a.md", content: "persisted" });
    });

    test("a chunk whose vector size is wrong is skipped, not inserted", async () => {
        await worker.putMulti([dto({ path: "bad.md", embedding: [1, 0] })]);
        expect(worker.count()).toBe(0);
    });
});

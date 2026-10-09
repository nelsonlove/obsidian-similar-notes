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

    test("removeByPath clears every chunk of a note with more than one search page", async () => {
        const many = Array.from({ length: 150 }, (_, i) =>
            dto({ path: "big.md", chunkIndex: i, totalChunks: 150, content: `c${i}`, embedding: unit(1, i / 150, 0, 0) })
        );
        await worker.putMulti([...many, dto({ path: "other.md", embedding: unit(0, 0, 1, 0) })]);
        expect(worker.count()).toBe(151);

        expect(await worker.removeByPath("big.md")).toBe(true);
        expect(worker.count()).toBe(1);

        // No ghost hits with blank text.
        const hits = await worker.findSimilarChunks(unit(1, 0.5, 0, 0), 10);
        expect(hits.map((h) => h.chunk.path)).toEqual(["other.md"]);
    });

    test("re-indexing a note refreshes the text its hits return", async () => {
        await worker.putMulti([dto({ path: "a.md", content: "old", embedding: unit(1, 0, 0, 0) })]);
        expect((await worker.findSimilarChunks(unit(1, 0, 0, 0), 5))[0].chunk.content).toBe("old");

        await worker.removeByPath("a.md");
        await worker.putMulti([dto({ path: "a.md", content: "new", embedding: unit(1, 0, 0, 0) })]);
        expect((await worker.findSimilarChunks(unit(1, 0, 0, 0), 5))[0].chunk.content).toBe("new");
    });

    test("concurrent misses on one hit path share a single IndexedDB read", async () => {
        await worker.putMulti([dto({ path: "a.md", content: "t", embedding: unit(1, 0, 0, 0) })]);
        const storage = (worker as unknown as { storage: { getByPath: (p: string) => Promise<unknown[]> } }).storage;
        const original = storage.getByPath.bind(storage);
        let reads = 0;
        storage.getByPath = async (p: string) => {
            reads++;
            return original(p);
        };

        await Promise.all([
            worker.findSimilarChunks(unit(1, 0, 0, 0), 5),
            worker.findSimilarChunks(unit(1, 0, 0, 0), 5),
            worker.findSimilarChunks(unit(1, 0, 0, 0), 5),
        ]);
        await worker.findSimilarChunks(unit(1, 0, 0, 0), 5);

        expect(reads).toBe(1);
        const w = worker as unknown as { contentCacheChunks: number; contentCache: Map<string, Map<number, string>> };
        expect(w.contentCacheChunks).toBe(1);
        expect(w.contentCache.size).toBe(1);
    });

    test("a write that lands while a read is in flight is not overwritten by the stale read", async () => {
        await worker.putMulti([dto({ path: "a.md", content: "old", embedding: unit(1, 0, 0, 0) })]);
        const storage = (worker as unknown as { storage: { getByPath: (p: string) => Promise<unknown[]> } }).storage;
        const original = storage.getByPath.bind(storage);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => (release = r));
        let first = true;
        storage.getByPath = async (p: string) => {
            if (first) {
                first = false;
                const rows = await original(p); // reads "old"
                await gate; // ...and is held past the write below
                return rows;
            }
            return original(p);
        };

        const pending = worker.findSimilarChunks(unit(1, 0, 0, 0), 5);
        await new Promise((r) => setTimeout(r, 10));
        await worker.removeByPath("a.md");
        await worker.putMulti([dto({ path: "a.md", content: "new", embedding: unit(1, 0, 0, 0) })]);
        release();
        await pending;

        // The next query must see the new text, not a cached stale "old".
        const hits = await worker.findSimilarChunks(unit(1, 0, 0, 0), 5);
        expect(hits[0].chunk.content).toBe("new");
    });

    test("a query that arrives after a write does not join a pre-write read", async () => {
        await worker.putMulti([dto({ path: "a.md", content: "old", embedding: unit(1, 0, 0, 0) })]);
        const storage = (worker as unknown as { storage: { getByPath: (p: string) => Promise<unknown[]> } }).storage;
        const original = storage.getByPath.bind(storage);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => (release = r));
        let first = true;
        storage.getByPath = async (p: string) => {
            if (first) {
                first = false;
                const rows = await original(p);
                await gate;
                return rows;
            }
            return original(p);
        };

        const stale = worker.findSimilarChunks(unit(1, 0, 0, 0), 5);
        await new Promise((r) => setTimeout(r, 10));
        await worker.removeByPath("a.md");
        await worker.putMulti([dto({ path: "a.md", content: "new", embedding: unit(1, 0, 0, 0) })]);
        const fresh = worker.findSimilarChunks(unit(1, 0, 0, 0), 5);
        release();

        expect((await fresh)[0].chunk.content).toBe("new");
        expect((await stale)[0].chunk.content).toBe("old");
    });

    test("a chunk whose vector size is wrong is skipped, not inserted", async () => {
        await worker.putMulti([dto({ path: "bad.md", embedding: [1, 0] })]);
        expect(worker.count()).toBe(0);
    });
});

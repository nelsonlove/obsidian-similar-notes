import { describe, expect, test } from "vitest";
import { create, insert, insertMultiple, remove, search } from "@orama/orama";
import type { NoteChunkInternal } from "@/infrastructure/IndexedDBChunkStorage";
import {
    createIndexDocumentPropertiesGetter,
    createIndexSchema,
    createSlimIndexPlugin,
    toIndexDocument,
} from "../indexDocument";

function chunk(overrides?: Partial<NoteChunkInternal>): NoteChunkInternal {
    return {
        path: "a/b.md",
        pathHash: "hash",
        title: "b",
        content: "the chunk text",
        chunkIndex: 0,
        totalChunks: 1,
        embedding: [1, 0, 0],
        lastUpdated: 1,
        ...overrides,
    };
}

type VectorEntries = Map<number, [number, Float32Array]>;
function indexedVectors(db: unknown): VectorEntries {
    return (db as { data: { index: { vectorIndexes: { embedding: { node: { vectors: VectorEntries } } } } } })
        .data.index.vectorIndexes.embedding.node.vectors;
}
function storedDocs(db: unknown): Record<string, { embedding: unknown }> {
    return (db as { data: { docs: { docs: Record<string, { embedding: unknown }> } } }).data.docs.docs;
}

async function slimDb() {
    return create({
        schema: createIndexSchema(3),
        components: { getDocumentProperties: createIndexDocumentPropertiesGetter() as never },
        plugins: [createSlimIndexPlugin()],
    });
}

describe("toIndexDocument: the slim in-memory shape (orama-index-memory spec)", () => {
    test("drops the chunk text and keeps what a hit needs", () => {
        const doc = toIndexDocument(chunk());
        expect(doc).not.toHaveProperty("content");
        expect(doc).toMatchObject({
            path: "a/b.md",
            pathHash: "hash",
            title: "b",
            chunkIndex: 0,
            totalChunks: 1,
            lastUpdated: 1,
        });
    });

    test("gives every document a unique explicit id", () => {
        const a = toIndexDocument(chunk());
        const b = toIndexDocument(chunk());
        expect(a.id).not.toBe(b.id);
        expect(a.id.startsWith("hash:0:")).toBe(true);
    });

    test("the schema has no content field", () => {
        expect(createIndexSchema(3)).not.toHaveProperty("content");
        expect(createIndexSchema(3).embedding).toBe("vector[3]");
    });
});

describe("createSlimIndexPlugin: one Float32Array per chunk, shared with the vector index", () => {
    test("insertMultiple: stored docs point at the index's own typed array", async () => {
        const db = await slimDb();
        const docs = [toIndexDocument(chunk()), toIndexDocument(chunk({ embedding: [0, 1, 0] }))];
        await insertMultiple(db, docs as never[]);

        const vectors = Array.from(indexedVectors(db).values()).map(([, v]) => v);
        for (const stored of Object.values(storedDocs(db))) {
            expect(stored.embedding).toBeInstanceOf(Float32Array);
            expect(vectors).toContain(stored.embedding); // same instance, not a copy
        }
        expect(vectors).toHaveLength(2);
    });

    test("insert: the single-document hook compacts the same way", async () => {
        const db = await slimDb();
        await insert(db, toIndexDocument(chunk()) as never);
        const [stored] = Object.values(storedDocs(db));
        expect(stored.embedding).toBeInstanceOf(Float32Array);
        expect(Array.from(indexedVectors(db).values())[0][1]).toBe(stored.embedding);
    });

    test("search still ranks by the vector, and a hit carries no vector", async () => {
        const db = await slimDb();
        await insertMultiple(db, [
            toIndexDocument(chunk({ path: "x.md", embedding: [1, 0, 0] })),
            toIndexDocument(chunk({ path: "y.md", embedding: [0, 1, 0] })),
        ] as never[]);
        const r = await search(db, {
            mode: "vector",
            vector: { value: [0, 1, 0], property: "embedding" },
            similarity: 0,
            limit: 5,
        } as never);
        expect(r.hits.map((h) => (h.document as { path: string }).path)).toEqual(["y.md", "x.md"]);
        expect((r.hits[0].document as { embedding: unknown }).embedding).toBeNull();
    });

    test("remove after compaction still drops the vector from the index", async () => {
        const db = await slimDb();
        const doc = toIndexDocument(chunk());
        await insertMultiple(db, [doc] as never[]);
        expect(indexedVectors(db).size).toBe(1);
        await remove(db, doc.id);
        expect(indexedVectors(db).size).toBe(0);
        expect(Object.keys(storedDocs(db))).toHaveLength(0);
    });
});

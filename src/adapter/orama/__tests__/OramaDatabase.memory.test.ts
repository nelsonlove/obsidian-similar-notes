import { describe, expect, test } from "vitest";
import { create, insertMultiple } from "@orama/orama";
import type { NoteChunkInternal } from "@/infrastructure/IndexedDBChunkStorage";
import {
    createIndexDocumentPropertiesGetter,
    createIndexSchema,
    createSlimIndexPlugin,
    toIndexDocument,
} from "../indexDocument";

/**
 * Resident-memory measurement behind docs/orama-index-memory-spec.md.
 *
 * Run with an exposed GC for a precise number:
 *   NODE_OPTIONS=--expose-gc npx vitest run src/adapter/orama/__tests__/OramaDatabase.memory.test.ts
 * Without `gc` the test is skipped (a GC-less heap delta is noise).
 *
 * Shape of the index before this change ("legacy"): the whole stored chunk went
 * into Orama — `number[]` embedding (8 bytes/dim, kept in the document store)
 * plus Orama's own Float32Array copy in the vector index, plus the chunk text.
 * After ("slim"): one Float32Array per chunk shared by the document store and
 * the vector index, and no text.
 */
const CHUNKS = 10_000;
const DIM = 1536; // text-embedding-3-small
const CONTENT_CHARS = 1_500; // ~ a 512-token chunk of English prose

type Gc = () => void;
const gc = (globalThis as { gc?: Gc }).gc;

// A 64-hex-character hash per note, as calculatePathHash produces.
function fakeSha256(n: number): string {
    return n.toString(16).padStart(8, "0").repeat(8);
}

function makeChunk(i: number): NoteChunkInternal {
    const embedding = new Array<number>(DIM);
    for (let d = 0; d < DIM; d++) {
        embedding[d] = Math.sin(i * 0.001 + d);
    }
    return {
        path: `notes/note-${i % 500}.md`,
        pathHash: fakeSha256(i % 500),
        title: `note-${i % 500}`,
        content: `chunk ${i} `.repeat(CONTENT_CHARS / 8).slice(0, CONTENT_CHARS),
        chunkIndex: i % 20,
        totalChunks: 20,
        embedding,
        lastUpdated: 1,
    };
}

function residentBytes(): number {
    const m = process.memoryUsage();
    // Float32Array backing stores are off the JS heap (arrayBuffers).
    return m.heapUsed + m.arrayBuffers;
}

async function settle(): Promise<number> {
    gc?.();
    await new Promise((r) => setTimeout(r, 50));
    gc?.();
    return residentBytes();
}

const legacySchema = {
    path: "string",
    pathHash: "string",
    title: "string",
    embedding: `vector[${DIM}]`,
    lastUpdated: "number",
    content: "string",
    chunkIndex: "number",
    totalChunks: "number",
} as const;

async function buildLegacy(): Promise<unknown> {
    const db = await create({ schema: legacySchema });
    for (let start = 0; start < CHUNKS; start += 100) {
        const batch: NoteChunkInternal[] = [];
        for (let i = start; i < Math.min(start + 100, CHUNKS); i++) batch.push(makeChunk(i));
        await insertMultiple(db, batch as never[]);
    }
    return db;
}

async function buildSlim(): Promise<unknown> {
    const db = await create({
        schema: createIndexSchema(DIM),
        components: { getDocumentProperties: createIndexDocumentPropertiesGetter() as never },
        plugins: [createSlimIndexPlugin()],
    });
    for (let start = 0; start < CHUNKS; start += 100) {
        const batch = [];
        for (let i = start; i < Math.min(start + 100, CHUNKS); i++) {
            // As in production: the number[] from IndexedDB is transient.
            batch.push(toIndexDocument(makeChunk(i)));
        }
        await insertMultiple(db, batch as never[]);
    }
    return db;
}

describe.skipIf(typeof gc !== "function")(
    `Orama index resident memory for ${CHUNKS} chunks x ${DIM} dims`,
    () => {
        test(
            "the slim index holds well under half of the legacy index",
            async () => {
                const base1 = await settle();
                let legacy: unknown = await buildLegacy();
                const legacyBytes = (await settle()) - base1;
                legacy = null;
                void legacy;

                const base2 = await settle();
                let slim: unknown = await buildSlim();
                const slimBytes = (await settle()) - base2;
                slim = null;
                void slim;

                const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
                // eslint-disable-next-line no-console
                console.log(
                    `[orama-index-memory] legacy ${mb(legacyBytes)} MB, slim ${mb(slimBytes)} MB, ` +
                        `ratio ${(legacyBytes / slimBytes).toFixed(2)}x, ` +
                        `per chunk legacy ${(legacyBytes / CHUNKS / 1024).toFixed(1)} KB, slim ${(slimBytes / CHUNKS / 1024).toFixed(1)} KB`
                );

                expect(slimBytes).toBeLessThan(legacyBytes / 2);
                // Lower bound: one Float32Array per chunk cannot be beaten.
                expect(slimBytes).toBeGreaterThan(CHUNKS * DIM * 4 * 0.9);
            },
            120_000
        );
    }
);

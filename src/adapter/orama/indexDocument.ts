import type { NoteChunkInternal } from "@/infrastructure/IndexedDBChunkStorage";
import { type AnyOrama, type OramaPlugin, components } from "@orama/orama";

/**
 * What the in-memory Orama index holds per chunk: what is needed to rank a hit
 * and identify its note, and nothing else.
 *
 * - `content` is NOT here. It lives only in IndexedDB and is read back, per
 *   hit path and cached, for the hits a search returns
 *   (`OramaWorker.findSimilarChunks`).
 * - `embedding` goes in as the stored `number[]` (Orama's insert validation
 *   accepts only a plain array for a `vector[N]` field) and is compacted right
 *   after insertion by `createSlimIndexPlugin`: the document store then points
 *   at the very Float32Array (4 bytes per dimension) the vector index built,
 *   so there is a single copy per chunk. The previous shape kept the
 *   `number[]` (8 bytes per dimension) in the document store AND Orama's
 *   Float32Array in the vector index, plus the chunk text — roughly 3x the
 *   resident size for a 1536-dimension model.
 *
 * After a vector search Orama nulls the vector field on the hit documents in
 * place (`includeVectors` is false), so a hit never carries an embedding; the
 * vector index keeps its own reference and search is unaffected.
 *
 * See docs/orama-index-memory-spec.md for the measured numbers.
 */
export interface IndexDocument {
    /** Orama document id. Explicit so the post-insert hook can find the vector it just indexed (Orama assigns a random id otherwise and does not write it on the doc). */
    id: string;
    path: string;
    pathHash: string;
    title: string;
    embedding: number[] | Float32Array;
    chunkIndex: number;
    totalChunks: number;
    lastUpdated: number;
}

export type IndexSchema = {
    path: "string";
    pathHash: "string";
    title: "string";
    embedding: `vector[${number}]`;
    chunkIndex: "number";
    totalChunks: "number";
    lastUpdated: "number";
};

export function createIndexSchema(vectorSize: number): IndexSchema {
    return {
        path: "string",
        pathHash: "string",
        title: "string",
        embedding: `vector[${vectorSize}]`,
        chunkIndex: "number",
        totalChunks: "number",
        lastUpdated: "number",
    };
}

/** Keeps ids unique across re-inserts of the same path and chunk index. */
let nextDocumentSeq = 0;

/**
 * Build the slim index document for a stored chunk. The IndexedDB record keeps
 * its `number[]` embedding (storage format unchanged); only the in-memory copy
 * is compacted, after insertion, by the plugin below.
 */
export function toIndexDocument(chunk: NoteChunkInternal): IndexDocument {
    return {
        id: `${chunk.pathHash}:${chunk.chunkIndex}:${nextDocumentSeq++}`,
        path: chunk.path,
        pathHash: chunk.pathHash,
        title: chunk.title,
        embedding: chunk.embedding,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        lastUpdated: chunk.lastUpdated,
    };
}

/**
 * Orama's vector index keeps `[magnitude, Float32Array]` per internal document
 * id (`@orama/orama` 3.x, `trees/vector.js`). This locates that typed array for
 * the document just inserted, or returns null if the layout is not the one
 * expected (then the caller falls back to its own Float32Array copy).
 */
function findIndexedVector(
    orama: AnyOrama,
    id: string,
    property: string
): Float32Array | null {
    try {
        const internalId = components.internalDocumentIDStore.getInternalDocumentId(
            orama.internalDocumentIDStore,
            id
        );
        const data = orama.data as unknown as {
            index?: {
                vectorIndexes?: Record<
                    string,
                    { node?: { vectors?: Map<number, [number, Float32Array]> } }
                >;
            };
        };
        const entry = data.index?.vectorIndexes?.[property]?.node?.vectors?.get(internalId);
        return entry && entry[1] instanceof Float32Array ? entry[1] : null;
    } catch {
        return null;
    }
}

type DocumentPropertiesGetter = (
    doc: Record<string, unknown>,
    paths: string[]
) => Record<string, unknown>;

/**
 * Orama's default `getDocumentProperties` walks a typed array as if it were a
 * nested object (`Array.isArray` is false for a Float32Array), so once the
 * embedding has been compacted, `remove()` would read it as `undefined`, skip
 * the vector index, and leave a stale vector behind. This getter hands the
 * vector field over as-is and defers every other field to the default.
 */
export function createIndexDocumentPropertiesGetter(
    property = "embedding"
): DocumentPropertiesGetter {
    return (doc, paths) => {
        const wantsVector = paths.includes(property);
        const otherPaths = wantsVector ? paths.filter((p) => p !== property) : paths;
        const result = components.getDocumentProperties(
            doc as never,
            otherPaths
        ) as Record<string, unknown>;
        if (wantsVector) {
            result[property] = doc[property];
        }
        return result;
    };
}

function compactEmbedding(orama: AnyOrama, doc: unknown, property: string): void {
    const stored = doc as Record<string, unknown>;
    const value = stored[property];
    if (value === undefined || value instanceof Float32Array) {
        return;
    }
    const id = orama.getDocumentIndexId(doc as never);
    const shared = findIndexedVector(orama, id, property);
    stored[property] = shared ?? Float32Array.from(value as ArrayLike<number>);
}

/**
 * Orama plugin: after each insert, replace the stored document's `number[]`
 * embedding with the vector index's own Float32Array. `remove()` still finds a
 * defined value for the field, so the vector is still dropped with the doc.
 * `insertMultiple` runs `insert` per document (so `afterInsert` fires for
 * each) and then `afterInsertMultiple` once; the second pass is a no-op for
 * an already-compacted document and is kept as a guard for a future Orama
 * that batches differently.
 */
export function createSlimIndexPlugin(property = "embedding"): OramaPlugin {
    return {
        name: "similar-notes-slim-index",
        afterInsert(orama: AnyOrama, _id: string, doc: unknown) {
            compactEmbedding(orama, doc, property);
        },
        afterInsertMultiple(orama: AnyOrama, docs: unknown[]) {
            for (const doc of docs) {
                compactEmbedding(orama, doc, property);
            }
        },
    };
}

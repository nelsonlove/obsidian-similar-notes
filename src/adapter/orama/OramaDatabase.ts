import type { NoteChunkDTO } from "@/domain/model/NoteChunkDTO";
import {
    IndexedDBChunkStorage,
    type NoteChunkInternal,
} from "@/infrastructure/IndexedDBChunkStorage";
import {
    type Orama,
    type SearchParams,
    type TypedDocument,
    count,
    create,
    insert,
    insertMultiple,
    remove,
    search,
} from "@orama/orama";
import log from "loglevel";
import {
    createIndexDocumentPropertiesGetter,
    createIndexSchema,
    createSlimIndexPlugin,
    type IndexDocument,
    type IndexSchema,
    toIndexDocument,
} from "./indexDocument";

type Schema = IndexSchema;
type Doc = TypedDocument<Orama<Schema>>;

export class OramaWorker {
    private db: Orama<Schema> | null = null;
    private schema: Schema;
    private vectorSize: number;
    private storage: IndexedDBChunkStorage;

    setLogLevel(level: log.LogLevelDesc): void {
        log.setLevel(level);
        log.info(`Worker log level set to: ${log.getLevel()}`);
    }

    async init(
        vectorSize: number,
        vaultId: string,
        loadExistingData: boolean
    ): Promise<void> {
        this.vectorSize = vectorSize;
        this.db = null;
        this.schema = createIndexSchema(vectorSize);

        try {
            // Initialize IndexedDB storage with vault-specific ID
            this.storage = new IndexedDBChunkStorage();
            await this.storage.init(vaultId);

            if (!loadExistingData) {
                // Reindex scenario: clear IndexedDB to start fresh
                await this.storage.clear();
                log.info("Cleared IndexedDB for reindexing");
            }

            // Create empty Orama database. The index holds slim documents
            // (no chunk text, one Float32Array per chunk) — see indexDocument.ts.
            this.db = (await create({
                schema: this.schema,
                components: {
                    getDocumentProperties: createIndexDocumentPropertiesGetter() as never,
                },
                plugins: [createSlimIndexPlugin()],
            })) as Orama<Schema>;

            if (loadExistingData) {
                // Load data from IndexedDB in batches
                log.info("Loading chunks from IndexedDB...");
                let loadedCount = 0;
                await this.storage.loadInBatches(
                    100,
                    async (batch) => {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        await insertMultiple(this.db!, this.toDocs(batch));
                    },
                    (processed, total) => {
                        loadedCount = processed;
                        if (processed % 500 === 0 || processed === total) {
                            log.info(
                                `Loaded ${processed}/${total} chunks from IndexedDB`
                            );
                        }
                    }
                );

                log.info(
                    `Successfully loaded ${loadedCount} chunks from IndexedDB`
                );
            } else {
                log.info("Starting with empty database for reindexing");
            }
        } catch (error) {
            log.error("Failed to initialize database", error);
            throw error;
        }
    }


    async put(noteChunk: NoteChunkDTO): Promise<void> {
        if (!this.db) {
            throw new Error("Database not loaded");
        }

        // Validate chunk before inserting
        if (!this.isValidChunk(noteChunk)) {
            log.error(`Skipping invalid chunk: ${noteChunk.path} (chunk ${noteChunk.chunkIndex})`);
            return;
        }

        const pathHash = await this.calculatePathHash(noteChunk.path);
        const internalNoteChunk: NoteChunkInternal = {
            ...noteChunk,
            pathHash,
            lastUpdated: Date.now(),
        };

        // Insert to both Orama (in-memory, slim) and IndexedDB (persistent, full)
        await insert(this.db, this.toDoc(internalNoteChunk));
        await this.storage.put(internalNoteChunk);
    }

    async putMulti(chunks: NoteChunkDTO[]): Promise<void> {
        if (!this.db) {
            throw new Error("Database not loaded");
        }

        // Filter out invalid chunks
        const validChunks = chunks.filter(chunk => {
            const isValid = this.isValidChunk(chunk);
            if (!isValid) {
                log.error(`Skipping invalid chunk: ${chunk.path} (chunk ${chunk.chunkIndex})`);
            }
            return isValid;
        });

        if (validChunks.length === 0) {
            log.warn("No valid chunks to insert");
            return;
        }

        const internalChunks: NoteChunkInternal[] = await Promise.all(
            validChunks.map(async (chunk) => ({
                ...chunk,
                pathHash: await this.calculatePathHash(chunk.path),
                lastUpdated: Date.now(),
            }))
        );

        // Insert to both Orama (in-memory, slim) and IndexedDB (persistent, full)
        await insertMultiple(this.db, this.toDocs(internalChunks));
        await this.storage.putMulti(internalChunks);
    }

    /** Slim in-memory shape of a stored chunk (see indexDocument.ts). */
    private toDoc(chunk: NoteChunkInternal): Doc {
        return toIndexDocument(chunk) as unknown as Doc;
    }

    private toDocs(chunks: NoteChunkInternal[]): Doc[] {
        return chunks.map((chunk) => this.toDoc(chunk));
    }

    /**
     * Validate chunk data before inserting into database
     * Ensures embedding is a non-empty array to prevent schema validation errors
     */
    private isValidChunk(chunk: NoteChunkDTO | NoteChunkInternal): boolean {
        if (!chunk.embedding) {
            log.warn(`Chunk has no embedding: ${chunk.path} (chunk ${chunk.chunkIndex})`);
            return false;
        }
        if (!Array.isArray(chunk.embedding)) {
            log.warn(`Chunk embedding is not an array: ${chunk.path} (chunk ${chunk.chunkIndex})`);
            return false;
        }
        if (chunk.embedding.length === 0) {
            log.warn(`Chunk embedding is empty array: ${chunk.path} (chunk ${chunk.chunkIndex})`);
            return false;
        }
        if (chunk.embedding.length !== this.vectorSize) {
            log.warn(`Chunk embedding size mismatch: expected ${this.vectorSize}, got ${chunk.embedding.length} for ${chunk.path} (chunk ${chunk.chunkIndex})`);
            return false;
        }
        return true;
    }

    /**
     * Helper function to calculate a SHA-256 hash for a filepath
     */
    private async calculatePathHash(path: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(path);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
    }

    async removeByPath(path: string): Promise<boolean> {
        if (!this.db) {
            throw new Error("Database not loaded");
        }
        const pathHash = await this.calculatePathHash(path);
        const results = await search(this.db, {
            term: pathHash,
            properties: ["pathHash"],
            exact: true,
            limit: 100,
        });

        // Remove from Orama
        if (results.hits.length > 0) {
            for (const hit of results.hits) {
                await remove(this.db, hit.id);
            }
        }

        // Remove from IndexedDB
        const removedCount = await this.storage.removeByPath(path);

        return removedCount > 0;
    }

    async renamePath(oldPath: string, newPath: string): Promise<boolean> {
        if (!this.db) {
            throw new Error("Database not loaded");
        }

        // Pull chunks from IndexedDB — Orama's vector search results don't
        // return the full embedding, but storage has it intact.
        const existing = await this.storage.getByPath(oldPath);
        if (existing.length === 0) {
            return false;
        }

        const newPathHash = await this.calculatePathHash(newPath);
        const renamed: NoteChunkInternal[] = existing.map((chunk) => {
            const { id: _id, ...rest } = chunk;
            return {
                ...rest,
                path: newPath,
                pathHash: newPathHash,
                lastUpdated: Date.now(),
            };
        });

        // Remove the old entries from both Orama and IndexedDB, then write
        // the renamed copies back. Embeddings are preserved as-is, so the
        // search results for the moved note are unchanged.
        await this.removeByPath(oldPath);
        await insertMultiple(this.db, this.toDocs(renamed));
        await this.storage.putMulti(renamed);

        return true;
    }

    async getByPath(path: string): Promise<NoteChunkDTO[]> {
        if (!this.db) {
            throw new Error("Database not loaded");
        }

        // Get chunks directly from IndexedDB to ensure embeddings are included
        // Text-based search in Orama doesn't return vector fields
        const chunks = await this.storage.getByPath(path);

        return chunks.map((chunk) => ({
            path: chunk.path,
            title: chunk.title,
            content: chunk.content,
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            embedding: chunk.embedding,
        }));
    }

    async findSimilarChunks(
        queryEmbedding: number[],
        limit: number,
        minScore?: number,
        excludePaths?: string[]
    ): Promise<{ chunk: NoteChunkDTO; score: number }[]> {
        if (!this.db) {
            throw new Error("Database not loaded");
        }

        const batchSize = limit * 2;
        let offset = 0;
        let hits: { doc: IndexDocument; score: number }[] = [];

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const searchParams: SearchParams<Orama<Schema>> = {
                mode: "vector",
                vector: {
                    value: queryEmbedding,
                    property: "embedding",
                },
                similarity: minScore ?? 0,
                limit: batchSize,
                offset: offset,
            };

            const results = await search(this.db, searchParams);

            // If no more results found, break the loop
            if (results.hits.length === 0) {
                break;
            }

            // Filter results based on excludePaths
            const filteredHits = results.hits.filter((hit) => {
                if (excludePaths) {
                    return !excludePaths.includes(hit.document.path);
                }
                return true;
            });

            hits = hits.concat(
                filteredHits.map((hit) => ({
                    doc: hit.document as unknown as IndexDocument,
                    score: hit.score,
                }))
            );

            // If we have enough results, break the loop
            if (hits.length >= limit) {
                hits = hits.slice(0, limit);
                break;
            }

            // Increment offset for next batch
            offset += batchSize;
        }

        // The index holds no chunk text; read it back from IndexedDB for the
        // hits only (one read per distinct note path).
        const contentByPath = await this.loadContent(
            Array.from(new Set(hits.map((hit) => hit.doc.path)))
        );

        // Orama's vector search nulls the vector field on returned hits, so a
        // hit never carries its embedding (it never did); callers that need
        // embeddings use getByPath, which reads IndexedDB.
        return hits.map(({ doc, score }) => ({
            chunk: {
                path: doc.path,
                title: doc.title,
                content: contentByPath.get(doc.path)?.get(doc.chunkIndex) ?? "",
                chunkIndex: doc.chunkIndex,
                totalChunks: doc.totalChunks,
                embedding: [],
            },
            score,
        }));
    }

    /** chunk text per note path, keyed by chunk index. */
    private async loadContent(
        paths: string[]
    ): Promise<Map<string, Map<number, string>>> {
        const result = new Map<string, Map<number, string>>();
        await Promise.all(
            paths.map(async (path) => {
                const byIndex = new Map<number, string>();
                for (const chunk of await this.storage.getByPath(path)) {
                    byIndex.set(chunk.chunkIndex, chunk.content);
                }
                result.set(path, byIndex);
            })
        );
        return result;
    }

    count(): number {
        if (!this.db) {
            throw new Error("Database not loaded");
        }
        return count(this.db);
    }
}

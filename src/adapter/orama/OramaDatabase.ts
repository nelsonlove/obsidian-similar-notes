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

/** Page size for the remove-by-path search loop. */
const REMOVE_PAGE_SIZE = 100;
/** Upper bound on chunks whose text is cached for hits (~1.5 KB each). */
const CONTENT_CACHE_MAX_CHUNKS = 2000;

export class OramaWorker {
    private db: Orama<Schema> | null = null;
    private schema: Schema;
    private vectorSize: number;
    private storage: IndexedDBChunkStorage;
    /**
     * Chunk text by note path, keyed by chunk index, for recently loaded hit
     * paths. The index holds no text, and SimilarNoteFinder queries once per
     * chunk of the active note, so the same hit paths come up again and
     * again; this keeps each path's text to one IndexedDB read per write to
     * that path. Bounded by chunk count (oldest loaded path evicted first);
     * invalidated on every write to the path, including a write that lands
     * while a read for the path is in flight (see contentGeneration).
     */
    private contentCache = new Map<string, Map<number, string>>();
    private contentCacheChunks = 0;
    /** In-flight reads by path, so concurrent misses share one read. */
    private contentLoads = new Map<string, Promise<Map<number, string>>>();
    /** Bumped on every write to a path; a read caches only if unchanged. */
    private contentGeneration = new Map<string, number>();

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
        this.contentCache.clear();
        this.contentCacheChunks = 0;
        this.contentLoads.clear();
        this.contentGeneration.clear();

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
        this.dropCachedContent(noteChunk.path);
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
        for (const chunk of internalChunks) {
            this.dropCachedContent(chunk.path);
        }
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

        // Remove from Orama. The search is paged, so loop until no hit is
        // left: a note with more than one page of chunks must not leave
        // stale documents behind (they would surface as hits with no text).
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const results = await search(this.db, {
                term: pathHash,
                properties: ["pathHash"],
                exact: true,
                limit: REMOVE_PAGE_SIZE,
            });
            if (results.hits.length === 0) {
                break;
            }
            let removed = 0;
            for (const hit of results.hits) {
                if (await remove(this.db, hit.id)) {
                    removed++;
                }
            }
            if (removed === 0) {
                // A page that cannot be removed would loop forever; log and stop.
                log.error(`removeByPath: ${results.hits.length} hits for ${path} could not be removed`);
                break;
            }
        }

        // Remove from IndexedDB
        const removedCount = await this.storage.removeByPath(path);
        this.dropCachedContent(path);

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
        this.dropCachedContent(newPath);

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

        // The index holds no chunk text; resolve it for the hit paths from
        // the per-path cache, reading IndexedDB on a miss.
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

    /** Chunk text per note path, keyed by chunk index; cached per path. */
    private async loadContent(
        paths: string[]
    ): Promise<Map<string, Map<number, string>>> {
        const result = new Map<string, Map<number, string>>();
        await Promise.all(
            paths.map(async (path) => {
                result.set(path, await this.loadContentForPath(path));
            })
        );
        return result;
    }

    private loadContentForPath(path: string): Promise<Map<number, string>> {
        const cached = this.contentCache.get(path);
        if (cached) {
            return Promise.resolve(cached);
        }
        const inFlight = this.contentLoads.get(path);
        if (inFlight) {
            return inFlight;
        }
        const generation = this.contentGeneration.get(path) ?? 0;
        const load = (async () => {
            try {
                const byIndex = new Map<number, string>();
                for (const chunk of await this.storage.getByPath(path)) {
                    byIndex.set(chunk.chunkIndex, chunk.content);
                }
                // A write to the path while the read was in flight bumped
                // the generation; what was read may predate it, so do not
                // cache it (the result is still returned for this query).
                if ((this.contentGeneration.get(path) ?? 0) === generation) {
                    this.cacheContent(path, byIndex);
                }
                return byIndex;
            } finally {
                this.contentLoads.delete(path);
            }
        })();
        this.contentLoads.set(path, load);
        return load;
    }

    private dropCachedContent(path: string): void {
        this.contentGeneration.set(path, (this.contentGeneration.get(path) ?? 0) + 1);
        const cached = this.contentCache.get(path);
        if (cached) {
            this.contentCacheChunks -= cached.size;
            this.contentCache.delete(path);
        }
    }

    private cacheContent(path: string, byIndex: Map<number, string>): void {
        if (byIndex.size > CONTENT_CACHE_MAX_CHUNKS) {
            return;
        }
        // Replace, never double-count, an entry already present for the path.
        const existing = this.contentCache.get(path);
        if (existing) {
            this.contentCacheChunks -= existing.size;
            this.contentCache.delete(path);
        }
        // Evict oldest paths (Map keeps insertion order) until this one fits.
        while (
            this.contentCache.size > 0 &&
            this.contentCacheChunks + byIndex.size > CONTENT_CACHE_MAX_CHUNKS
        ) {
            const oldest = this.contentCache.keys().next().value as string;
            this.contentCacheChunks -= this.contentCache.get(oldest)?.size ?? 0;
            this.contentCache.delete(oldest);
        }
        this.contentCache.set(path, byIndex);
        this.contentCacheChunks += byIndex.size;
    }

    count(): number {
        if (!this.db) {
            throw new Error("Database not loaded");
        }
        return count(this.db);
    }
}

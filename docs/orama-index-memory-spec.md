# Orama index memory

## Problem

`OramaWorker` keeps the whole search index in memory and rebuilds it from IndexedDB at every start. Until now each chunk went into Orama as the full stored record: path, title, chunk text, and the embedding as a `number[]`. Orama keeps that document object in its document store as given, and its vector index builds a separate `Float32Array` from the array. So per chunk the renderer held:

- the `number[]` embedding in the document store: 8 bytes per dimension (12 KB at 1536 dimensions),
- the `Float32Array` copy in the vector index: 4 bytes per dimension (6 KB),
- the chunk text: about 1.5 KB for a 512-token English chunk, more for CJK,
- the small fields and Orama's own per-document bookkeeping.

A 20,000-note vault with a 1536-dimension model (OpenAI `text-embedding-3-small`) chunks into tens of thousands of entries, and the index alone reached the order of a gigabyte in the Obsidian renderer. That is a large share of what pushed Obsidian out of memory on large vaults.

## Design

`src/adapter/orama/indexDocument.ts` defines what the index holds (`IndexDocument`) and how it gets there:

1. **No chunk text in the index.** The schema has no `content` field and the document does not carry it. Text stays in IndexedDB; `findSimilarChunks` reads it back for the hit paths only, through the per-path cache in item 6.
2. **One Float32Array per chunk.** Orama's insert validation accepts only a plain array for a `vector[N]` field, so the document goes in with the stored `number[]`. A post-insert plugin (`createSlimIndexPlugin`, hooked on `afterInsert`, which `insertMultiple` also fires per document, with an idempotent `afterInsertMultiple` pass as a guard) then replaces the stored document's `embedding` with the very `Float32Array` the vector index built for it, found through the document's explicit `id`. The `number[]` becomes garbage. Document store and vector index now share a single 4-byte-per-dimension copy.
3. **Typed arrays survive `remove`.** Orama's default `getDocumentProperties` treats a typed array as a nested object and returns `undefined` for it, so `remove()` would skip the vector index and leave a stale vector. `createIndexDocumentPropertiesGetter` hands the vector field through as-is and defers every other field to the default; it is installed as the `getDocumentProperties` component.
4. **Explicit document ids.** `toIndexDocument` gives each document an `id` (`pathHash:chunkIndex:sequence`), because Orama otherwise assigns a random id without writing it on the document, and the hook needs the id to find the document's vector.
5. **Remove loops over pages.** `removeByPath` pages its `pathHash` search (100 per page) and loops until no hit is left; a page that removes nothing throws, so the change reaches the errored machinery rather than being recorded as processed with documents left behind. With text no longer in the index, a stale document left behind by a single-page removal would surface as a hit with blank text, so the old single-page removal (a latent bug for notes over 100 chunks) is fixed here.
6. **Hit text is cached per path.** `SimilarNoteFinder` queries once per chunk of the active note, so the same hit paths recur across queries and across refreshes. The worker keeps the text of recently loaded hit paths, bounded at 2,000 chunks (about 3 MB of English text, more for scripts that take two bytes per character in JavaScript strings; a path with more chunks than the bound is never cached), evicting the oldest loaded path first. Concurrent misses on one path share one IndexedDB read. Every write to a path drops its entry, drops any in-flight read for it (a later query starts a fresh read), and bumps a per-path generation; a read that was in flight across the write, or across an `init`, returns its result but does not cache it. So each path costs one IndexedDB read per change rather than one per query. The memory test below measures the index alone; the cache is on top of it and is bounded as stated.

Nothing about the IndexedDB record changes: it still stores the `number[]` embedding and the text, so existing indexes load unchanged and no reindex is needed.

## Measured

`src/adapter/orama/__tests__/OramaDatabase.memory.test.ts` builds the two shapes for 10,000 chunks of 1536 dimensions with 1,500-character text, 64-hex-character path hashes as in production, and 500 distinct notes, and measures `heapUsed + arrayBuffers` after a forced GC (`NODE_OPTIONS=--expose-gc`; the test is skipped without it). Node 26, Orama 3.1.1, 2026-10-09:

| shape | resident | per chunk |
| --- | --- | --- |
| legacy (full record, `number[]` + index copy + text) | 230.1 MB | 23.6 KB |
| slim (shared Float32Array, no text) | 78.2 MB | 8.0 KB |

Ratio 2.94x. The slim figure is 6 KB of vector plus Orama's per-document overhead (ids, radix entries for `path`, `pathHash` and `title`, the internal id maps). The test asserts slim < legacy / 2 and slim > 0.9 x the raw vector bytes, so a regression that reintroduces a second copy or the text fails it.

## What a hit returns

A hit's `NoteChunkDTO` now has `embedding: []`. Orama nulls the vector field on hit documents in place (`includeVectors` defaults to false), so hits never carried an embedding before either; `getByPath` (IndexedDB) is the way to a chunk's embedding and is what `SimilarNoteFinder` uses.

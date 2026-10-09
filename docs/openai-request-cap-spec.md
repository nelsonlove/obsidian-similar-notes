# OpenAI embeddings request cap

## Problem

`NoteIndexingService.processUpdatedNote` embeds a whole note in one `embedTexts` call. For the OpenAI provider that call was one HTTP request with every chunk of the note as `input[]`. The endpoint caps a request two ways at once: at most 2048 inputs, and at most 300,000 tokens summed over the inputs. A long note (an imported chat transcript, a long log) chunks into hundreds of ~512-token chunks, so the request overran the token cap and the note failed with HTTP 400. It was retried `MAX_ATTEMPTS` (3) times, failing identically each time, and then landed in the errored store. Every other note in the same session went through, so the failure was easy to miss.

## Design

`OpenAIEmbeddingProvider.embedTexts` now plans its requests before sending anything:

1. Estimate the tokens of each input with the provider's `countTokens` (the chars/4 or chars/1 heuristic already used for chunk sizing).
2. Refuse a single input whose estimate exceeds the model's input limit (`maxTokens`, 8191 by default) or the per-request budget, with an error that names the input and says nothing was sent. The chunker caps chunks at 512 tokens, so this only fires for a misconfigured custom model or a defective chunk.
3. Split the inputs into consecutive batches with `splitByBudget` (`src/utils/batching.ts`): each batch holds at most `MAX_INPUTS_PER_REQUEST` (2048) inputs and at most `MAX_ESTIMATED_TOKENS_PER_REQUEST` (100,000) estimated tokens.
4. Send the batches one after another, concatenate the embeddings in input order, and track the summed usage once.

## Why 100,000 and not 300,000

The estimate undercounts token-dense text: with `cl100k_base`, markdown tables, paths, numbers and code run closer to 3 characters per token than 4, and the ASCII heuristic assumes 4. A third of the hard cap leaves a 3x margin, so a note that estimates at 100k tokens still fits even when it really is 300k. The cost of a lower budget is one extra request per ~100k tokens, which is noise next to the embedding call itself.

## Why sequential

A failed request stops the loop, so a 400 or a 429 on the second request of a note spends nothing on the remaining ones. Parallelism across notes is unchanged (`NoteIndexingService` still processes up to 5 notes at once for cloud providers).

## Not changed

- Gemini batches by `batchEmbedContents` with its own limits; it is not touched here.
- The chunk size itself (see `docs/semantic-chunk-size-spec.md`).

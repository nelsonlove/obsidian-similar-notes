import { type ApiKeySource, OpenAIClient, UsageTracker } from "@/adapter/openai";
import type { SettingsService } from "@/application/SettingsService";
import { splitByBudget } from "@/utils/batching";
import { handleEmbeddingLoadError } from "@/utils/errorHandling";
import log from "loglevel";
import { type Observable, Subject } from "rxjs";
import { type EmbeddingProvider, type ModelInfo } from "./EmbeddingProvider";

export interface OpenAIConfig {
    url: string;
    /** A key value, or a function read on every request (see ApiKeySource). */
    apiKey?: ApiKeySource;
    model: string;
    maxTokens?: number;
    settingsService?: SettingsService;
}

// Default max tokens for OpenAI text-embedding-3 models
const DEFAULT_MAX_TOKENS = 8191;

/**
 * Per-request caps for the embeddings endpoint. OpenAI rejects a request with
 * more than 2048 inputs or more than 300,000 summed tokens (HTTP 400). The
 * token budget is an *estimate* budget (see countTokens), kept at a third of
 * the hard cap so an undercount of 2-3x on symbol-heavy text still fits.
 * See docs/openai-request-cap-spec.md.
 */
export const MAX_INPUTS_PER_REQUEST = 2048;
export const MAX_ESTIMATED_TOKENS_PER_REQUEST = 100_000;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
    private openaiClient: OpenAIClient;
    private usageTracker: UsageTracker | null = null;
    private modelId: string | null = null;
    private vectorSize: number | null = null;
    private maxTokens: number = DEFAULT_MAX_TOKENS;
    private modelBusy$ = new Subject<boolean>();
    private downloadProgress$ = new Subject<number>();
    private modelError$ = new Subject<string | null>();

    constructor(private config: OpenAIConfig) {
        this.openaiClient = new OpenAIClient(config.url, config.apiKey);
        if (config.maxTokens) {
            this.maxTokens = config.maxTokens;
        }
        if (config.settingsService) {
            this.usageTracker = new UsageTracker(config.settingsService);
        }
    }

    async loadModel(modelId: string, config?: OpenAIConfig): Promise<ModelInfo> {
        const finalConfig = config || this.config;
        log.info("Loading OpenAI model", modelId, "from", finalConfig.url);

        // Clear any previous error state
        this.modelError$.next(null);

        // Update client if config changed
        if (finalConfig.url !== this.config.url) {
            this.openaiClient.setBaseUrl(finalConfig.url);
            this.config.url = finalConfig.url;
        }
        if (finalConfig.apiKey !== this.config.apiKey) {
            this.openaiClient.setApiKey(finalConfig.apiKey);
            this.config.apiKey = finalConfig.apiKey;
        }
        if (finalConfig.maxTokens) {
            this.maxTokens = finalConfig.maxTokens;
        }

        try {
            // Test connection and get vector size by generating a test embedding
            const testResult = await this.openaiClient.embedText(modelId, "test");
            this.vectorSize = testResult.embedding.length;

            this.modelId = modelId;
            this.config.model = modelId;

            log.info("OpenAI model loaded successfully", {
                modelId,
                vectorSize: this.vectorSize,
                maxTokens: this.maxTokens,
            });

            return {
                vectorSize: this.vectorSize,
                maxTokens: this.maxTokens,
            };
        } catch (error) {
            log.error("Failed to load OpenAI model:", error);

            handleEmbeddingLoadError(error, {
                providerName: "OpenAI",
                errorSubject: this.modelError$,
            });
        }
    }

    async unloadModel(): Promise<void> {
        this.modelId = null;
        this.vectorSize = null;
        log.info("OpenAI model unloaded");
    }

    getModelBusy$(): Observable<boolean> {
        return this.modelBusy$.asObservable();
    }

    getDownloadProgress$(): Observable<number> {
        // OpenAI doesn't need to download models, always return 100%
        return this.downloadProgress$.asObservable();
    }

    getModelError$(): Observable<string | null> {
        return this.modelError$.asObservable();
    }

    async embedText(text: string): Promise<number[]> {
        if (!this.modelId) {
            throw new Error("OpenAI model not loaded");
        }

        this.modelBusy$.next(true);
        try {
            const result = await this.openaiClient.embedText(this.modelId, text);
            // Clear error state on success
            this.modelError$.next(null);

            // Track usage if available
            if (result.usage && this.usageTracker) {
                await this.usageTracker.trackUsage(
                    result.usage.prompt_tokens,
                    result.usage.total_tokens
                );
            }

            return result.embedding;
        } catch (error) {
            log.error("Failed to embed text with OpenAI:", error);
            throw error;
        } finally {
            this.modelBusy$.next(false);
        }
    }

    async embedTexts(texts: string[]): Promise<number[][]> {
        if (!this.modelId) {
            throw new Error("OpenAI model not loaded");
        }
        if (texts.length === 0) {
            return [];
        }

        this.modelBusy$.next(true);
        try {
            const requests = await this.planRequests(texts);
            if (requests.length > 1) {
                log.info(
                    `[OpenAI] Splitting ${texts.length} inputs into ${requests.length} requests`
                );
            }

            const embeddings: number[][] = [];

            // Sequential on purpose: peak payload is one request, and a failure
            // stops before further requests are spent. Usage is recorded per
            // request, so a request that succeeded before a later one failed
            // is still counted.
            for (const batch of requests) {
                const result = await this.openaiClient.embedTexts(this.modelId, batch);
                embeddings.push(...result.embeddings);
                if (result.usage && this.usageTracker) {
                    await this.usageTracker.trackUsage(
                        result.usage.prompt_tokens,
                        result.usage.total_tokens
                    );
                }
            }

            // Clear error state on success
            this.modelError$.next(null);

            return embeddings;
        } catch (error) {
            log.error("Failed to embed texts with OpenAI:", error);
            throw error;
        } finally {
            this.modelBusy$.next(false);
        }
    }

    /**
     * Group `texts` into request-sized batches under both per-request caps.
     * A single input above the per-request budget can never be sent and is
     * refused here, before anything goes out, with a message naming it. An
     * input above the model's own `maxTokens` is still sent as before: the
     * estimate is rough, and an OpenAI-compatible server may truncate or
     * accept it (chunk 0 carries the title and can exceed a small custom
     * limit by a few tokens).
     */
    private async planRequests(texts: string[]): Promise<string[][]> {
        const costs = await Promise.all(texts.map((t) => this.countTokens(t)));
        const over = costs.findIndex((c) => c > MAX_ESTIMATED_TOKENS_PER_REQUEST);
        if (over !== -1) {
            throw new Error(
                `Input ${over + 1} of ${texts.length} is ~${costs[over]} tokens, above the ${MAX_ESTIMATED_TOKENS_PER_REQUEST}-token request limit; nothing was sent`
            );
        }
        return splitByBudget(texts, costs, {
            maxItems: MAX_INPUTS_PER_REQUEST,
            maxCost: MAX_ESTIMATED_TOKENS_PER_REQUEST,
        });
    }

    async countTokens(text: string): Promise<number> {
        // Token efficiency varies by language with cl100k_base encoding:
        // - English/ASCII: ~4 chars per token
        // - Korean/Japanese/Chinese: ~1 char per token (sometimes slightly more)
        //
        // Use adaptive ratio based on ASCII content percentage:
        // - Mostly ASCII (>80%): use /4 for efficiency
        // - Mixed or non-ASCII: use /1 for safety (Korean can be ~1.1 chars/token)
        const asciiRatio = this.getAsciiRatio(text);
        const charsPerToken = asciiRatio > 0.8 ? 4 : 1;
        return Math.ceil(text.length / charsPerToken);
    }

    /**
     * Calculate the ratio of ASCII characters in the text
     */
    private getAsciiRatio(text: string): number {
        if (text.length === 0) return 1;
        let asciiCount = 0;
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) < 128) {
                asciiCount++;
            }
        }
        return asciiCount / text.length;
    }

    getVectorSize(): number {
        if (!this.vectorSize) {
            throw new Error("OpenAI model not loaded");
        }
        return this.vectorSize;
    }

    getMaxTokens(): number {
        return this.maxTokens;
    }

    isModelLoaded(): boolean {
        return this.modelId !== null;
    }

    getCurrentModelId(): string | null {
        return this.modelId;
    }

    dispose(): void {
        this.unloadModel().catch((err) => {
            log.error("Error during OpenAI provider disposal:", err);
        });
    }

    /**
     * Update OpenAI configuration
     */
    updateConfig(config: Partial<OpenAIConfig>): void {
        if (config.url) {
            this.config.url = config.url;
            this.openaiClient.setBaseUrl(config.url);
        }
        if (config.apiKey !== undefined) {
            this.config.apiKey = config.apiKey;
            this.openaiClient.setApiKey(config.apiKey);
        }
        if (config.model) {
            this.config.model = config.model;
        }
    }

    /**
     * Get current configuration
     */
    getConfig(): OpenAIConfig {
        return { ...this.config };
    }

    /**
     * OpenAI supports parallel file processing for better throughput
     */
    supportsParallelProcessing(): boolean {
        return true;
    }

    /**
     * OpenAI supports usage tracking for cost estimation
     */
    supportsUsageTracking(): boolean {
        return true;
    }
}

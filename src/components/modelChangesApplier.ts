import type { SimilarNotesSettings, SettingsService } from "@/application/SettingsService";
import { OpenAIApiKeyStore } from "@/infrastructure/OpenAIApiKeyStore";
import { Notice } from "obsidian";
import type { App } from "obsidian";
import { SECRET_STORAGE_UNAVAILABLE_MESSAGE } from "./OpenAISettingsSection";
import type MainPlugin from "../main";
import { LoadModelModal } from "./LoadModelModal";
import { fetchAndCacheModelInfo } from "./modelInfoCache";

export interface ModelChangesApplierParams {
    plugin: MainPlugin;
    settingsService: SettingsService;
    app: App;
    settings: SimilarNotesSettings;
    tempModelProvider?: "builtin" | "ollama" | "openai" | "gemini";
    tempModelId?: string;
    tempOllamaUrl?: string;
    tempOllamaModel?: string;
    tempUseGPU?: boolean;
    tempOpenaiUrl?: string;
    tempOpenaiApiKeySecretId?: string;
    tempOpenaiModel?: string;
    tempOpenaiMaxTokens?: number;
    tempGeminiApiKey?: string;
    tempGeminiModel?: string;
    onComplete: () => void;
}

/**
 * Applies model configuration changes and triggers reindexing
 */
export async function applyModelChanges(params: ModelChangesApplierParams): Promise<void> {
    const {
        plugin,
        settingsService,
        app,
        settings,
        tempModelProvider: provider,
        tempModelId,
        tempOllamaUrl,
        tempOllamaModel,
        tempUseGPU,
        tempOpenaiUrl,
        tempOpenaiApiKeySecretId,
        tempOpenaiModel,
        tempOpenaiMaxTokens,
        tempGeminiApiKey,
        tempGeminiModel,
        onComplete,
    } = params;

    if (!provider) return;

    // Determine message and model ID based on provider
    const isBuiltin = provider === "builtin";
    const message = isBuiltin
        ? "The model will be downloaded from Hugging Face (this might take a while) and all your notes will be reindexed. Do you want to continue?"
        : "Your embedding model will be changed and all notes will be reindexed. Do you want to continue?";

    const getModelId = () => {
        if (provider === "builtin") return tempModelId || settings.modelId;
        if (provider === "ollama") return tempOllamaModel || "";
        if (provider === "openai") return tempOpenaiModel || "text-embedding-3-small";
        return tempGeminiModel || "gemini-embedding-001";
    };

    new LoadModelModal(
        app,
        message,
        async () => {
            const modelId = getModelId();
            const cachedModelInfo = await fetchAndCacheModelInfo(
                provider,
                modelId,
                provider === "ollama" ? tempOllamaUrl : undefined
            );

            const updateData: Partial<SimilarNotesSettings> = {
                modelProvider: provider,
                cachedModelInfo,
            };

            if (provider === "builtin") {
                updateData.modelId = modelId;
                updateData.useGPU = tempUseGPU ?? settings.useGPU;
            } else if (provider === "ollama") {
                updateData.ollamaUrl = tempOllamaUrl;
                updateData.ollamaModel = tempOllamaModel;
            } else if (provider === "openai") {
                updateData.openaiUrl = tempOpenaiUrl ?? settings.openaiUrl;
                // Only the secret ID is saved, and only when secret storage
                // exists; the key itself never goes into data.json.
                const secretId = tempOpenaiApiKeySecretId ?? settings.openaiApiKeySecretId;
                if (secretId && !OpenAIApiKeyStore.fromApp(app).isAvailable()) {
                    new Notice(`Similar Notes: ${SECRET_STORAGE_UNAVAILABLE_MESSAGE}`);
                } else {
                    updateData.openaiApiKeySecretId = secretId;
                }
                updateData.openaiModel = tempOpenaiModel ?? "text-embedding-3-small";
                updateData.openaiMaxTokens = tempOpenaiMaxTokens ?? settings.openaiMaxTokens;
            } else if (provider === "gemini") {
                updateData.geminiApiKey = tempGeminiApiKey ?? settings.geminiApiKey;
                updateData.geminiModel = tempGeminiModel ?? "gemini-embedding-001";
            }

            await settingsService.update(updateData);
            plugin.changeModel(modelId);
            onComplete();
        },
        Function.prototype as () => void
    ).open();
}

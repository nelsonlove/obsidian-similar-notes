import { GeminiClient } from "@/adapter/gemini";
import type { SimilarNotesSettings } from "@/application/SettingsService";
import { ApiKeyStore } from "@/infrastructure/ApiKeyStore";
import { Notice, SecretComponent } from "obsidian";
import type { App, Setting } from "obsidian";
import { SECRET_STORAGE_UNAVAILABLE_MESSAGE } from "./OpenAISettingsSection";

export type SettingBuilder = (setting: Setting) => void;

interface GeminiSettingsSectionProps {
    app: App;
    settings: SimilarNotesSettings;
    /** ID of the secret in Obsidian's secret storage, never the key itself. */
    tempGeminiApiKeySecretId: string | undefined;
    tempGeminiModel: string | undefined;
    onGeminiApiKeySecretIdChange: (value: string) => void;
    onGeminiModelChange: (value: string) => void;
    onRender: () => void;
    // Getter functions to get latest temp values (to avoid closure issues)
    getTempValues?: () => { apiKeySecretId?: string; model?: string };
}

// Predefined Gemini embedding models
const GEMINI_MODELS = [
    { id: "gemini-embedding-001", name: "gemini-embedding-001 (Recommended)" },
];

export function getGeminiSettingBuilders(props: GeminiSettingsSectionProps): SettingBuilder[] {
    const {
        app,
        settings,
        tempGeminiApiKeySecretId,
        tempGeminiModel,
        onGeminiApiKeySecretIdChange,
        onGeminiModelChange,
        onRender,
        getTempValues,
    } = props;

    const keyStore = ApiKeyStore.fromApp(app);
    const geminiApiKeySecretId =
        tempGeminiApiKeySecretId ?? settings.geminiApiKeySecretId ?? "";
    const geminiModel = tempGeminiModel ?? settings.geminiModel ?? "gemini-embedding-001";
    const isCustomModel = !GEMINI_MODELS.some((m) => m.id === geminiModel);

    const builders: SettingBuilder[] = [
        // API key: picked from Obsidian's secret storage; the key value never
        // touches data.json, only the secret's ID is saved. No fallback.
        (setting) => {
            setting.setName("API key");
            if (!keyStore.isAvailable()) {
                setting.setDesc(SECRET_STORAGE_UNAVAILABLE_MESSAGE);
                return;
            }
            setting.setDesc(
                "Pick the secret that holds your Google AI Studio API key (get one from aistudio.google.com; add it under Settings → General → Secrets)."
            );
            new SecretComponent(app, setting.controlEl)
                .setValue(geminiApiKeySecretId)
                .onChange((value) => {
                    onGeminiApiKeySecretIdChange(value);
                });
        },
        // Model dropdown
        (setting) => {
            setting
                .setName("Model")
                .setDesc("Select an embedding model")
                .addDropdown((dropdown) => {
                    // Add predefined models
                    GEMINI_MODELS.forEach((model) => {
                        dropdown.addOption(model.id, model.name);
                    });
                    // Add custom option
                    dropdown.addOption("custom", "Custom model...");

                    // Set current value
                    dropdown.setValue(isCustomModel ? "custom" : geminiModel);

                    dropdown.onChange((value) => {
                        if (value === "custom") {
                            // Set to "custom" to trigger custom input display
                            onGeminiModelChange("custom");
                        } else {
                            onGeminiModelChange(value);
                        }
                        onRender();
                    });
                });
        },
    ];

    // Show custom model input if custom is selected
    if (isCustomModel) {
        builders.push((setting) => {
            setting
                .setName("Custom model ID")
                .setDesc("Enter the Gemini model ID")
                .addText((text) => {
                    text.setPlaceholder("model-name")
                        .setValue(geminiModel)
                        .onChange((value) => {
                            onGeminiModelChange(value);
                        });
                });
        });
    }

    // Test connection
    builders.push((setting) => {
        setting
            .setName("Test connection")
            .setDesc("Test the connection to the Gemini API")
            .addButton((button) => {
                button.setButtonText("Test").onClick(async () => {
                    // Use getter function to get latest temp values (avoids closure issues)
                    const tempValues = getTempValues?.() ?? {};
                    const secretId = tempValues.apiKeySecretId ?? settings.geminiApiKeySecretId;
                    const apiKey = () => keyStore.getApiKey(secretId) ?? undefined;
                    const model = tempValues.model ?? settings.geminiModel ?? "gemini-embedding-001";

                    if (!apiKey()) {
                        new Notice("Please pick a secret that holds an API key first");
                        return;
                    }

                    if (!model) {
                        new Notice("Please select or enter a model first");
                        return;
                    }

                    new Notice(`Testing connection with model ${model}...`);

                    try {
                        const client = new GeminiClient(apiKey);
                        const success = await client.testConnection(model);

                        if (success) {
                            new Notice("Connection successful! Model is ready for embeddings.");
                        } else {
                            new Notice("Connection failed: Could not generate test embedding");
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        new Notice(`Connection failed: ${errorMessage}`);
                    }
                });
            });
    });

    return builders;
}

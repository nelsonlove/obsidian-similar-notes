import { OpenAIClient } from "@/adapter/openai";
import type { SimilarNotesSettings } from "@/application/SettingsService";
import { OpenAIApiKeyStore } from "@/infrastructure/OpenAIApiKeyStore";
import { Notice, SecretComponent } from "obsidian";
import type { App, Setting } from "obsidian";

export type SettingBuilder = (setting: Setting) => void;

interface OpenAISettingsSectionProps {
    app: App;
    settings: SimilarNotesSettings;
    tempOpenaiUrl: string | undefined;
    /** ID of the secret in Obsidian's secret storage, never the key itself. */
    tempOpenaiApiKeySecretId: string | undefined;
    tempOpenaiModel: string | undefined;
    tempOpenaiMaxTokens: number | undefined;
    onOpenaiUrlChange: (value: string) => void;
    onOpenaiApiKeySecretIdChange: (value: string) => void;
    onOpenaiModelChange: (value: string) => void;
    onOpenaiMaxTokensChange: (value: number | undefined) => void;
    onRender: () => void;
    // Getter functions to get latest temp values (to avoid closure issues)
    getTempValues?: () => {
        url?: string;
        apiKeySecretId?: string;
        model?: string;
        maxTokens?: number;
    };
}

export const SECRET_STORAGE_UNAVAILABLE_MESSAGE =
    "Obsidian 1.11.4 or newer is needed to keep the API key in secret storage. No key can be saved or used until then.";

// Predefined OpenAI embedding models
const OPENAI_MODELS = [
    { id: "text-embedding-3-small", name: "text-embedding-3-small (Recommended)" },
    { id: "text-embedding-3-large", name: "text-embedding-3-large" },
    { id: "text-embedding-ada-002", name: "text-embedding-ada-002 (Legacy)" },
];

const DEFAULT_OPENAI_URL = "https://api.openai.com/v1";

export function getOpenAISettingBuilders(props: OpenAISettingsSectionProps): SettingBuilder[] {
    const {
        app,
        settings,
        tempOpenaiUrl,
        tempOpenaiApiKeySecretId,
        tempOpenaiModel,
        tempOpenaiMaxTokens,
        onOpenaiUrlChange,
        onOpenaiApiKeySecretIdChange,
        onOpenaiModelChange,
        onOpenaiMaxTokensChange,
        onRender,
        getTempValues,
    } = props;

    const keyStore = OpenAIApiKeyStore.fromApp(app);
    const openaiUrl = tempOpenaiUrl ?? settings.openaiUrl ?? DEFAULT_OPENAI_URL;
    const openaiApiKeySecretId =
        tempOpenaiApiKeySecretId ?? settings.openaiApiKeySecretId ?? "";
    const openaiModel = tempOpenaiModel ?? settings.openaiModel ?? "text-embedding-3-small";
    const isCustomModel = !OPENAI_MODELS.some((m) => m.id === openaiModel);

    const builders: SettingBuilder[] = [
        // Server URL
        (setting) => {
            setting
                .setName("Server URL")
                .setDesc("URL of your OpenAI-compatible server (default: https://api.openai.com/v1)")
                .addText((text) => {
                    text.setPlaceholder(DEFAULT_OPENAI_URL)
                        .setValue(openaiUrl)
                        .onChange((value) => {
                            onOpenaiUrlChange(value);
                        });
                });
        },
        // API key: picked from Obsidian's secret storage (Settings → General →
        // Secrets). The key value never touches data.json; only the secret's
        // ID is saved. There is no plain text box and no fallback.
        (setting) => {
            setting.setName("API key");
            if (!keyStore.isAvailable()) {
                setting.setDesc(SECRET_STORAGE_UNAVAILABLE_MESSAGE);
                return;
            }
            setting.setDesc(
                "Pick the secret that holds your OpenAI API key (required for OpenAI, optional for local servers). Add one under Settings → General → Secrets."
            );
            new SecretComponent(app, setting.controlEl)
                .setValue(openaiApiKeySecretId)
                .onChange((value) => {
                    onOpenaiApiKeySecretIdChange(value);
                });
        },
        // Model dropdown
        (setting) => {
            setting
                .setName("Model")
                .setDesc("Select an embedding model")
                .addDropdown((dropdown) => {
                    // Add predefined models
                    OPENAI_MODELS.forEach((model) => {
                        dropdown.addOption(model.id, model.name);
                    });
                    // Add custom option
                    dropdown.addOption("custom", "Custom model...");

                    // Set current value
                    dropdown.setValue(isCustomModel ? "custom" : openaiModel);

                    dropdown.onChange((value) => {
                        if (value === "custom") {
                            // Set to "custom" to trigger custom input display
                            onOpenaiModelChange("custom");
                        } else {
                            onOpenaiModelChange(value);
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
                .setDesc("Enter the model ID for your OpenAI-compatible server")
                .addText((text) => {
                    text.setPlaceholder("model-name")
                        .setValue(openaiModel)
                        .onChange((value) => {
                            onOpenaiModelChange(value);
                        });
                });
        });

        // Max tokens input for custom models
        const openaiMaxTokens = tempOpenaiMaxTokens ?? settings.openaiMaxTokens;
        builders.push((setting) => {
            setting
                .setName("Max tokens")
                .setDesc("Maximum tokens per chunk for this model")
                .addText((text) => {
                    text.setPlaceholder("8191")
                        .setValue(openaiMaxTokens?.toString() ?? "")
                        .onChange((value) => {
                            const parsed = parseInt(value, 10);
                            onOpenaiMaxTokensChange(isNaN(parsed) ? undefined : parsed);
                        });
                });
        });
    }

    // Test connection
    builders.push((setting) => {
        setting
            .setName("Test connection")
            .setDesc("Test the connection to the server and model")
            .addButton((button) => {
                button.setButtonText("Test").onClick(async () => {
                    // Use getter function to get latest temp values (avoids closure issues)
                    const tempValues = getTempValues?.() ?? {};
                    const url = tempValues.url ?? settings.openaiUrl ?? DEFAULT_OPENAI_URL;
                    const apiKey =
                        keyStore.getApiKey(
                            tempValues.apiKeySecretId ?? settings.openaiApiKeySecretId
                        ) ?? undefined;
                    const model = tempValues.model ?? settings.openaiModel ?? "text-embedding-3-small";

                    if (!model) {
                        new Notice("Please select or enter a model first");
                        return;
                    }

                    new Notice(`Testing connection to ${url} with model ${model}...`);

                    try {
                        const client = new OpenAIClient(url, apiKey || undefined);
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

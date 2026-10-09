import type { SettingsService } from "@/application/SettingsService";
import log from "loglevel";
import type { App, SecretStorage } from "obsidian";

/**
 * The secret ID under which a key found in data.json is moved into Obsidian's
 * secret storage on first load. Lowercase alphanumeric with dashes, as
 * `SecretStorage.setSecret` requires.
 */
export const OPENAI_API_KEY_SECRET_ID = "similar-notes-openai-api-key";

export type LegacyKeyMigration =
    | "migrated"
    | "nothing-to-migrate"
    | "secret-storage-unavailable";

/**
 * The only path between the plugin and the OpenAI API key.
 *
 * The key lives in Obsidian's secret storage (`app.secretStorage`, Obsidian
 * 1.11.4+), never in data.json: data.json sits inside the vault, so anything
 * written there is carried by Obsidian Sync and by any vault backup. Settings
 * hold only the *secret ID* (`openaiApiKeySecretId`), chosen with Obsidian's
 * secret picker; the value is read from secret storage at send time.
 *
 * When secret storage is missing (an older Obsidian), there is no fallback:
 * `setApiKey` refuses, `getApiKey` yields null, and a key still sitting in
 * data.json is left untouched and unused (deleting it would lose the user's
 * only copy; using it would keep the leak alive).
 */
export class OpenAIApiKeyStore {
    constructor(private readonly secretStorage: SecretStorage | undefined) {}

    static fromApp(app: App): OpenAIApiKeyStore {
        // `secretStorage` is absent on Obsidian < 1.11.4.
        return new OpenAIApiKeyStore(
            (app as Partial<App>).secretStorage ?? undefined
        );
    }

    isAvailable(): boolean {
        return (
            this.secretStorage !== undefined &&
            typeof this.secretStorage.getSecret === "function" &&
            typeof this.secretStorage.setSecret === "function"
        );
    }

    /**
     * The key value for a secret ID, or null when there is no ID, no such
     * secret, or no secret storage.
     */
    getApiKey(secretId: string | undefined): string | null {
        if (!secretId || !this.isAvailable()) {
            return null;
        }
        try {
            return this.secretStorage?.getSecret(secretId) ?? null;
        } catch (error) {
            log.error("[OpenAIApiKeyStore] Failed to read secret:", error);
            return null;
        }
    }

    /**
     * Store a key value under `secretId`. Returns false, storing nothing, when
     * secret storage is unavailable — the caller tells the user.
     */
    setApiKey(secretId: string, value: string): boolean {
        if (!this.isAvailable()) {
            return false;
        }
        this.secretStorage?.setSecret(secretId, value);
        return true;
    }

    /**
     * One-time move of a legacy `openaiApiKey` from data.json into secret
     * storage under OPENAI_API_KEY_SECRET_ID. On success the settings carry
     * the secret ID and the plaintext field is removed from data.json.
     */
    async migrateLegacyKey(
        settingsService: SettingsService
    ): Promise<LegacyKeyMigration> {
        const legacyKey = settingsService.get().openaiApiKey;
        if (!legacyKey) {
            return "nothing-to-migrate";
        }
        if (!this.setApiKey(OPENAI_API_KEY_SECRET_ID, legacyKey)) {
            log.warn(
                "[OpenAIApiKeyStore] Secret storage unavailable; the legacy API key in data.json is left in place and is not used"
            );
            return "secret-storage-unavailable";
        }
        // `undefined` drops the field when data.json is serialized.
        await settingsService.update({
            openaiApiKey: undefined,
            openaiApiKeySecretId: OPENAI_API_KEY_SECRET_ID,
        });
        log.info(
            "[OpenAIApiKeyStore] Moved the OpenAI API key from data.json into secret storage"
        );
        return "migrated";
    }
}

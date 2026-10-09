import type { SettingsService, SimilarNotesSettings } from "@/application/SettingsService";
import log from "loglevel";
import type { App, SecretStorage } from "obsidian";

/**
 * The secret IDs under which keys found in data.json are moved into Obsidian's
 * secret storage on first load. Lowercase alphanumeric with dashes, as
 * `SecretStorage.setSecret` requires.
 */
export const OPENAI_API_KEY_SECRET_ID = "similar-notes-openai-api-key";
export const GEMINI_API_KEY_SECRET_ID = "similar-notes-gemini-api-key";

export type LegacyKeyMigration =
    | "migrated"
    | "nothing-to-migrate"
    | "secret-storage-unavailable";

/** A provider's legacy plaintext field and the field that names its secret. */
interface LegacyKeyField {
    legacyField: "openaiApiKey" | "geminiApiKey";
    secretIdField: "openaiApiKeySecretId" | "geminiApiKeySecretId";
    secretId: string;
}

const LEGACY_KEY_FIELDS: LegacyKeyField[] = [
    { legacyField: "openaiApiKey", secretIdField: "openaiApiKeySecretId", secretId: OPENAI_API_KEY_SECRET_ID },
    { legacyField: "geminiApiKey", secretIdField: "geminiApiKeySecretId", secretId: GEMINI_API_KEY_SECRET_ID },
];

/**
 * The only path between the plugin and a provider API key (OpenAI, Gemini).
 *
 * Keys live in Obsidian's secret storage (`app.secretStorage`, Obsidian
 * 1.11.4+), never in data.json: data.json sits inside the vault, so anything
 * written there is carried by Obsidian Sync and by any vault backup. Settings
 * hold only the *secret ID* (`openaiApiKeySecretId`, `geminiApiKeySecretId`),
 * chosen with Obsidian's secret picker; the value is read from secret storage
 * at send time.
 *
 * When secret storage is missing (an older Obsidian), there is no fallback:
 * `setApiKey` refuses, `getApiKey` yields null, and a key still sitting in
 * data.json is left untouched and unused (deleting it would lose the user's
 * only copy; using it would keep the leak alive).
 */
export class ApiKeyStore {
    constructor(private readonly secretStorage: SecretStorage | undefined) {}

    static fromApp(app: App): ApiKeyStore {
        // `secretStorage` is absent on Obsidian < 1.11.4.
        return new ApiKeyStore((app as Partial<App>).secretStorage ?? undefined);
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
            log.error("[ApiKeyStore] Failed to read secret:", error);
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
     * One-time move of every legacy plaintext key (`openaiApiKey`,
     * `geminiApiKey`) from data.json into secret storage under its fixed
     * secret ID. On success the settings carry the secret IDs and the
     * plaintext fields are removed from data.json. Returns
     * "secret-storage-unavailable" when a key is present but cannot be moved
     * (nothing is written then), "migrated" when at least one key moved.
     */
    async migrateLegacyKeys(settingsService: SettingsService): Promise<LegacyKeyMigration> {
        const settings = settingsService.get();
        const present = LEGACY_KEY_FIELDS.filter((f) => settings[f.legacyField]);
        if (present.length === 0) {
            return "nothing-to-migrate";
        }
        if (!this.isAvailable()) {
            log.warn(
                "[ApiKeyStore] Secret storage unavailable; the legacy API key(s) in data.json are left in place and are not used"
            );
            return "secret-storage-unavailable";
        }
        const update: Partial<SimilarNotesSettings> = {};
        for (const field of present) {
            this.setApiKey(field.secretId, settings[field.legacyField] as string);
            // `undefined` drops the field when data.json is serialized.
            update[field.legacyField] = undefined;
            update[field.secretIdField] = field.secretId;
        }
        await settingsService.update(update);
        log.info(
            `[ApiKeyStore] Moved ${present.map((f) => f.legacyField).join(", ")} from data.json into secret storage`
        );
        return "migrated";
    }
}

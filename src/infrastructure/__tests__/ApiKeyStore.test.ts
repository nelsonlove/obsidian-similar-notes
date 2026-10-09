import { describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => ({
    Platform: { isMobileApp: false },
}));

import { SettingsService } from "@/application/SettingsService";
import { ApiKeyStore, GEMINI_API_KEY_SECRET_ID, OPENAI_API_KEY_SECRET_ID } from "../ApiKeyStore";

// The values are placeholders, never real keys.
const LEGACY_OPENAI_KEY = "sk-placeholder-not-a-real-key";
const LEGACY_GEMINI_KEY = "AIza-placeholder-not-a-real-key";

function fakeSecretStorage() {
    const secrets = new Map<string, string>();
    return {
        secrets,
        setSecret: vi.fn((id: string, value: string) => {
            secrets.set(id, value);
        }),
        getSecret: vi.fn((id: string) => secrets.get(id) ?? null),
        listSecrets: vi.fn(() => Array.from(secrets.keys())),
    };
}

async function settingsWith(data: Record<string, unknown>) {
    const plugin = {
        loadData: vi.fn().mockResolvedValue(data),
        saveData: vi.fn().mockResolvedValue(undefined),
    };
    const service = new SettingsService(plugin as never);
    await service.load();
    return { service, plugin };
}

function lastSaved(plugin: { saveData: ReturnType<typeof vi.fn> }): Record<string, unknown> {
    return JSON.parse(JSON.stringify(plugin.saveData.mock.calls.at(-1)?.[0]));
}

describe("ApiKeyStore: keys live in secret storage, never in data.json", () => {
    test("moves a legacy OpenAI key out of data.json into secret storage once", async () => {
        const storage = fakeSecretStorage();
        const store = new ApiKeyStore(storage as never);
        const { service, plugin } = await settingsWith({ openaiApiKey: LEGACY_OPENAI_KEY });

        expect(await store.migrateLegacyKeys(service)).toBe("migrated");

        expect(storage.setSecret).toHaveBeenCalledWith(OPENAI_API_KEY_SECRET_ID, LEGACY_OPENAI_KEY);
        const saved = lastSaved(plugin);
        expect(saved).not.toHaveProperty("openaiApiKey");
        expect(saved.openaiApiKeySecretId).toBe(OPENAI_API_KEY_SECRET_ID);
        expect(saved).not.toHaveProperty("geminiApiKeySecretId");

        const again = await settingsWith(saved);
        expect(await store.migrateLegacyKeys(again.service)).toBe("nothing-to-migrate");
        expect(storage.setSecret).toHaveBeenCalledTimes(1);
    });

    test("moves a legacy Gemini key the same way", async () => {
        const storage = fakeSecretStorage();
        const store = new ApiKeyStore(storage as never);
        const { service, plugin } = await settingsWith({ geminiApiKey: LEGACY_GEMINI_KEY });

        expect(await store.migrateLegacyKeys(service)).toBe("migrated");

        expect(storage.setSecret).toHaveBeenCalledWith(GEMINI_API_KEY_SECRET_ID, LEGACY_GEMINI_KEY);
        const saved = lastSaved(plugin);
        expect(saved).not.toHaveProperty("geminiApiKey");
        expect(saved.geminiApiKeySecretId).toBe(GEMINI_API_KEY_SECRET_ID);
        expect(saved).not.toHaveProperty("openaiApiKeySecretId");
    });

    test("moves both keys in one save when both are present", async () => {
        const storage = fakeSecretStorage();
        const store = new ApiKeyStore(storage as never);
        const { service, plugin } = await settingsWith({
            openaiApiKey: LEGACY_OPENAI_KEY,
            geminiApiKey: LEGACY_GEMINI_KEY,
        });

        expect(await store.migrateLegacyKeys(service)).toBe("migrated");

        expect(plugin.saveData).toHaveBeenCalledTimes(1);
        const saved = lastSaved(plugin);
        expect(saved).not.toHaveProperty("openaiApiKey");
        expect(saved).not.toHaveProperty("geminiApiKey");
        expect(saved.openaiApiKeySecretId).toBe(OPENAI_API_KEY_SECRET_ID);
        expect(saved.geminiApiKeySecretId).toBe(GEMINI_API_KEY_SECRET_ID);
        expect(store.getApiKey(OPENAI_API_KEY_SECRET_ID)).toBe(LEGACY_OPENAI_KEY);
        expect(store.getApiKey(GEMINI_API_KEY_SECRET_ID)).toBe(LEGACY_GEMINI_KEY);
    });

    test("reads a key only through its secret ID", async () => {
        const storage = fakeSecretStorage();
        storage.secrets.set("my-secret", LEGACY_OPENAI_KEY);
        const store = new ApiKeyStore(storage as never);

        expect(store.getApiKey("my-secret")).toBe(LEGACY_OPENAI_KEY);
        expect(store.getApiKey("other")).toBeNull();
        expect(store.getApiKey(undefined)).toBeNull();
    });

    test("without secret storage: nothing is saved, nothing is read, data.json is not rewritten", async () => {
        const store = new ApiKeyStore(undefined);
        const { service, plugin } = await settingsWith({
            openaiApiKey: LEGACY_OPENAI_KEY,
            geminiApiKey: LEGACY_GEMINI_KEY,
        });

        expect(store.isAvailable()).toBe(false);
        expect(await store.migrateLegacyKeys(service)).toBe("secret-storage-unavailable");
        expect(plugin.saveData).not.toHaveBeenCalled();
        expect(store.setApiKey("id", LEGACY_OPENAI_KEY)).toBe(false);
        // No fallback to the legacy fields: the keys are simply not available.
        expect(store.getApiKey(OPENAI_API_KEY_SECRET_ID)).toBeNull();
        expect(store.getApiKey(GEMINI_API_KEY_SECRET_ID)).toBeNull();
    });

    test("fromApp tolerates an App without secretStorage", () => {
        expect(ApiKeyStore.fromApp({} as never).isAvailable()).toBe(false);
    });

    test("a storage that throws on read yields null, not a crash", () => {
        const storage = fakeSecretStorage();
        storage.getSecret.mockImplementation(() => {
            throw new Error("keychain locked");
        });
        expect(new ApiKeyStore(storage as never).getApiKey("x")).toBeNull();
    });
});

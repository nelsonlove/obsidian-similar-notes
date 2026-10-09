import { describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => ({
    Platform: { isMobileApp: false },
}));

import { SettingsService } from "@/application/SettingsService";
import { OPENAI_API_KEY_SECRET_ID, OpenAIApiKeyStore } from "../OpenAIApiKeyStore";

// The value is a placeholder, never a real key.
const LEGACY_KEY = "sk-placeholder-not-a-real-key";

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

describe("OpenAIApiKeyStore: the key lives in secret storage, never in data.json", () => {
    test("moves a legacy key out of data.json into secret storage once", async () => {
        const storage = fakeSecretStorage();
        const store = new OpenAIApiKeyStore(storage as never);
        const { service, plugin } = await settingsWith({ openaiApiKey: LEGACY_KEY });

        expect(await store.migrateLegacyKey(service)).toBe("migrated");

        expect(storage.setSecret).toHaveBeenCalledWith(OPENAI_API_KEY_SECRET_ID, LEGACY_KEY);
        // What goes back to disk has no key and carries the secret ID.
        const saved = plugin.saveData.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        expect(JSON.parse(JSON.stringify(saved))).not.toHaveProperty("openaiApiKey");
        expect(saved.openaiApiKeySecretId).toBe(OPENAI_API_KEY_SECRET_ID);
        expect(service.get().openaiApiKey).toBeUndefined();

        // A second load with the migrated data has nothing left to move.
        const again = await settingsWith(JSON.parse(JSON.stringify(saved)));
        expect(await store.migrateLegacyKey(again.service)).toBe("nothing-to-migrate");
        expect(storage.setSecret).toHaveBeenCalledTimes(1);
    });

    test("reads the key only through the secret ID", async () => {
        const storage = fakeSecretStorage();
        storage.secrets.set("my-secret", LEGACY_KEY);
        const store = new OpenAIApiKeyStore(storage as never);

        expect(store.getApiKey("my-secret")).toBe(LEGACY_KEY);
        expect(store.getApiKey("other")).toBeNull();
        expect(store.getApiKey(undefined)).toBeNull();
    });

    test("without secret storage: nothing is saved, nothing is read, data.json is not rewritten", async () => {
        const store = new OpenAIApiKeyStore(undefined);
        const { service, plugin } = await settingsWith({ openaiApiKey: LEGACY_KEY });

        expect(store.isAvailable()).toBe(false);
        expect(await store.migrateLegacyKey(service)).toBe("secret-storage-unavailable");
        expect(plugin.saveData).not.toHaveBeenCalled();
        expect(store.setApiKey("id", LEGACY_KEY)).toBe(false);
        // No fallback to the legacy field: the key is simply not available.
        expect(store.getApiKey("id")).toBeNull();
        expect(store.getApiKey(OPENAI_API_KEY_SECRET_ID)).toBeNull();
    });

    test("fromApp tolerates an App without secretStorage", () => {
        expect(OpenAIApiKeyStore.fromApp({} as never).isAvailable()).toBe(false);
    });

    test("a storage that throws on read yields null, not a crash", () => {
        const storage = fakeSecretStorage();
        storage.getSecret.mockImplementation(() => {
            throw new Error("keychain locked");
        });
        expect(new OpenAIApiKeyStore(storage as never).getApiKey("x")).toBeNull();
    });
});

# Provider API keys in Obsidian secret storage

## Problem

The OpenAI and Gemini API keys were plain strings in `data.json`. That file sits inside the vault's `.obsidian/` folder, so Obsidian Sync carries it to every device and any vault backup (a git mirror, a cloud folder) carries it too. A password-styled text box hid the key on screen but not on disk.

## Design

Obsidian 1.11.4 added `app.secretStorage` (`setSecret`, `getSecret`, `listSecrets`) and `SecretComponent`, a picker for the secrets the user keeps under Settings → General → Secrets. The plugin uses both and nothing else:

- **Settings hold a secret ID, never a key.** `SimilarNotesSettings.openaiApiKeySecretId` and `geminiApiKeySecretId` name the secrets; `openaiApiKey` and `geminiApiKey` are legacy fields that are read once (below) and never written again.
- **`ApiKeyStore`** (`src/infrastructure/ApiKeyStore.ts`) is the only path to a key: `getApiKey(secretId)` resolves it from secret storage at send time: `EmbeddingService` hands the OpenAI client a function that calls the store on every request (`ApiKeySource`), so a secret whose value is rotated in Obsidian takes effect on the next request with no reload, `setApiKey` writes one, and `isAvailable()` says whether secret storage exists.
- **One-time migration.** On load, `migrateLegacyKeys` moves every key found in `data.json` into secret storage (`similar-notes-openai-api-key`, `similar-notes-gemini-api-key`), writes the IDs into settings, and removes the plaintext fields from `data.json` in one save (a field set to `undefined` is dropped by the JSON serializer).
- **Settings tab.** The API key row of both providers is a `SecretComponent`; there is no text box. The "Test connection" buttons resolve the key the same way.
- **Gemini client.** `GeminiClient` takes the same `ApiKeySource` as the OpenAI client and resolves it per request (`x-goog-api-key` header).

## No fallback

If secret storage is missing (an Obsidian older than 1.11.4), the plugin refuses rather than degrades: `setApiKey` returns false and the settings tab shows a notice instead of a field, `getApiKey` returns null so no request carries a key, and a legacy key in `data.json` is left in place but not used (deleting it would lose the user's only copy; using it would keep the leak alive). A notice on load says so. `manifest.json` sets `minAppVersion` to 1.11.4, so this path is a guard, not a supported mode.


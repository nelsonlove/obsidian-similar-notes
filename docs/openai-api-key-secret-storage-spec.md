# OpenAI API key in Obsidian secret storage

## Problem

The OpenAI API key was a plain string in `data.json`. That file sits inside the vault's `.obsidian/` folder, so Obsidian Sync carries it to every device and any vault backup (a git mirror, a cloud folder) carries it too. A password-styled text box hid the key on screen but not on disk.

## Design

Obsidian 1.11.4 added `app.secretStorage` (`setSecret`, `getSecret`, `listSecrets`) and `SecretComponent`, a picker for the secrets the user keeps under Settings → General → Secrets. The plugin uses both and nothing else:

- **Settings hold a secret ID, never a key.** `SimilarNotesSettings.openaiApiKeySecretId` names the secret; `openaiApiKey` is a legacy field that is read once (below) and never written again.
- **`OpenAIApiKeyStore`** (`src/infrastructure/OpenAIApiKeyStore.ts`) is the only path to the key: `getApiKey(secretId)` resolves it from secret storage at send time: `EmbeddingService` hands the OpenAI client a function that calls the store on every request (`ApiKeySource`), so a secret whose value is rotated in Obsidian takes effect on the next request with no reload, `setApiKey` writes one, and `isAvailable()` says whether secret storage exists.
- **One-time migration.** On load, `migrateLegacyKey` moves a key found in `data.json` into secret storage under `similar-notes-openai-api-key`, writes that ID into settings, and removes the plaintext field from `data.json` (the field is set to `undefined`, which the JSON serializer drops).
- **Settings tab.** The API key row is a `SecretComponent`; there is no text box. The "Test connection" button resolves the key the same way.

## No fallback

If secret storage is missing (an Obsidian older than 1.11.4), the plugin refuses rather than degrades: `setApiKey` returns false and the settings tab shows a notice instead of a field, `getApiKey` returns null so no request carries a key, and a legacy key in `data.json` is left in place but not used (deleting it would lose the user's only copy; using it would keep the leak alive). A notice on load says so. `manifest.json` sets `minAppVersion` to 1.11.4, so this path is a guard, not a supported mode.

## Not changed

The Gemini key still lives in `data.json`; it was out of scope for this change and should follow the same pattern.

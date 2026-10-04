# Codex Fast

`extensions/codex-fast.ts` is a standalone Pi extension. It adds `/fast` and requests `service_tier: "priority"` on eligible provider payloads. It does not replace the editor, header, or footer, and does not make requests itself. In TUI mode it publishes a `codex-fast` status that the local footer displays as a highlighted `fast` indicator.

Load the file directly for one invocation:

```sh
pi --extension /path/to/pi-exts/extensions/codex-fast.ts
```

Do not load it alongside another extension registering `/fast` (including the old `open-tui-custom`).

## Commands

- `/fast on` — save enabled state and warn about **higher credit usage**.
- `/fast off` — save disabled state; this extension stops adding priority.
- `/fast status` or `/fast` — report the setting and applicability to the current model without writing anything.

Arguments have completions and are case-insensitive. Invalid arguments show usage without changing state.

“On” means **priority requested**, not confirmation that the server accepted priority or a guarantee of faster responses. Enabling applies to future eligible requests, not a request already in flight. The setting can be enabled while another provider is selected; it applies after switching to `openai-codex`.

## Provider-only restriction

Only the exact, case-sensitive provider ID `openai-codex` qualifies. **There is no model-ID or model-family whitelist.** New, renamed, and future models from that provider receive the same priority request without an extension update.

The ordinary `openai` API provider, Azure, and differently named custom/proxy providers are not enabled by this extension. This is a provider-ID check, not verification of a custom provider's endpoint or a model's actual server-side priority support. An unsupported tier may be rejected or ignored by the server; use `/fast off` if necessary.

For eligible requests, `before_provider_request` returns a shallow copy with `service_tier` set to `priority`, replacing any previous tier without mutating the original payload. Non-object and array payloads pass through unchanged. Disabled or unsupported requests are left alone, including any tier supplied by another extension or the provider.

## Footer indicator

With both this extension and `local-footer` enabled, the footer shows:

```text
openai-codex/Model · high · fast · █░░░░░░░░░ 100k/1M (10.0%)
```

`fast` is accent-highlighted and appears only while Fast is enabled and the selected provider is `openai-codex`. It means **priority requested**, not confirmed server acceptance. `/fast on`, `/fast off`, and provider changes refresh it immediately. Startup/reload restores the persisted state; shutdown clears the status. Failed saves keep the indicator consistent with the unchanged running setting.

Integration uses `ctx.ui.setStatus('codex-fast', 'fast')` and the footer's live `getExtensionStatuses()` data, with no config polling or replacement UI. Each extension still works alone; the standard Pi footer can also display the published status. No status is published in print, JSON, or RPC mode.

## Configuration and safety

The sole configuration file is `getAgentDir()/codex-fast.json`, normally `~/.pi/agent/codex-fast.json` (respecting Pi's agent-directory override):

```json
{
  "enabled": false
}
```

- Defaults to **off**, including before `session_start`.
- Loaded on `session_start`, including extension reload. There is no file watcher.
- A missing file means off and is not automatically created.
- Invalid JSON, a non-object root, a missing/non-boolean `enabled`, or a read error warns and defaults to off. A string such as `"true"` never enables paid priority. Other fields are ignored.
- Only explicit `/fast on` and `/fast off` write the file, containing only the boolean `enabled` setting.
- Saves write a private temporary file on the same filesystem and atomically rename it over the destination. A failed save reports the path/error and leaves the running setting unchanged, even when disabling fails. Temporary files are cleaned up on a best-effort basis.
- The setting is shared by sessions using the same agent directory. Last successful save wins; other running sessions see changes at their next `session_start`/reload.

No old `open-tui.json` settings are read, migrated, or modified. To preserve an existing opt-in during removal of the old UI extension, explicitly create the new boolean configuration before loading this extension, or run `/fast on` afterward.

The request hook also works in non-TUI modes. Notifications use Pi's UI when available (including RPC); without a UI, messages go to stderr, leaving machine-readable stdout untouched.

## Tests and attribution

Run `node --test tests/codex-fast.test.mjs` (or the repository's `npm test`) after installing the repository's development dependencies. Tests load TypeScript through jiti, mock Pi, and use isolated temporary agent directories. They cover provider-only gating, arbitrary/future model IDs, immutable payloads, malformed config, atomic persistence, reload, failed saves, commands/completions, legacy-config isolation, non-TUI behavior, and live footer integration in either startup order. No model or network calls are made.

The original provider/model gate, payload helper, and command behavior were adapted from `open-tui-custom`; the model whitelist has since been removed. The original MIT license and `Copyright (c) 2026 pi-open-tui contributors` notice are preserved directly in `extensions/codex-fast.ts`, so the single-file extension carries its attribution when copied.

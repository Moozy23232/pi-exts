# Codex Fast

`extensions/codex-fast.ts` is a standalone Pi extension. It adds `/fast` and requests `service_tier: "priority"` on eligible provider payloads. It does not change the editor, header, footer, or status widgets, and does not make requests itself.

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

“On” means **priority requested**, not confirmation that the server accepted priority or a guarantee of faster responses. Enabling applies to future eligible requests, not a request already in flight. The setting can be enabled while an unsupported model is selected; it applies after switching to a supported model.

## Exact model whitelist

Only the `openai-codex` provider qualifies, with these case-sensitive model IDs:

- `gpt-5.4` (exact match)
- `gpt-5.5` (exact match)
- `gpt-5.6` or any ID beginning `gpt-5.6-`

In particular, `gpt-5.4-mini`, `gpt-5.5-codex`, `gpt-5.60`, and the ordinary `openai` provider do not qualify. This deliberately preserves the old extension's whitelist rather than assuming future model support.

For eligible requests, `before_provider_request` returns a shallow copy with `service_tier` set to `priority`, replacing any previous tier without mutating the original payload. Non-object and array payloads pass through unchanged. Disabled or unsupported requests are left alone, including any tier supplied by another extension or the provider.

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

Run `node --test tests/codex-fast.test.mjs` (or the repository's `npm test`) after installing the repository's development dependencies. Tests load TypeScript through jiti, mock Pi, and use isolated temporary agent directories. They cover whitelist boundaries, immutable payloads, malformed config, atomic persistence, reload, failed saves, commands/completions, legacy-config isolation, and non-TUI behavior. No model or network calls are made.

The whitelist, payload helper, and command behavior were adapted from `open-tui-custom`. The original MIT license and `Copyright (c) 2026 pi-open-tui contributors` notice are preserved directly in `extensions/codex-fast.ts`, so the single-file extension carries its attribution when copied.

# pi-exts

Personal extensions for [Pi coding agent](https://pi.dev/).

## Extensions

| Extension | Description |
| --- | --- |
| [Local footer](docs/local-footer.md) | Working directory, Git status, model, thinking, live context and optional Fast indicator. No costs or session names. |
| [Codex Fast](docs/codex-fast.md) | Standalone `/fast on\|off\|status` for all `openai-codex` models, with live footer status. Off by default; no UI replacement. |

```text
~/work/demo · git main ↑1 ↓2 · S2 M1 ?3
example/Example Model · high · █░░░░░░░░░ 128k/1M (12.8%)
```

## Install

Requires Pi and Node.js 22.19.0 or newer. Git must be on `PATH` for repository status.
Tests use Pi 0.87.1 development dependencies; Codex Fast also loads with Pi 1.0.2.

```bash
pi install git:github.com/Moozy23232/pi-exts@feat/codex-fast-provider-only
```

This branch includes provider-only Fast gating and the live footer indicator.
Omit `@feat/codex-fast-provider-only` after it is merged into the default branch.
Run `/reload` in an existing Pi session after installation.

Existing installs filtered to `extensions/local-footer.ts` must also allow
`extensions/codex-fast.ts` in the package's `extensions` list in settings.
Codex Fast defaults to off. Use `/fast on` to opt in to priority requests with
**higher credit usage**, and `/fast status` to inspect the setting. When replacing
`open-tui-custom`, remove/disable that extension first to avoid duplicate `/fast`
commands. See [Codex Fast](docs/codex-fast.md) for configuration and migration.

### Avoid duplicate footers

Keep only one custom footer enabled:

- If you already have a standalone `~/.pi/agent/extensions/local-footer.ts`, move
  it **outside the auto-loaded extensions directory** before loading this package.
  You can keep it as a backup; do not load both copies.
- If you use `pi-cc-extensions`, merge this setting into
  `~/.pi/agent/pi-cc-extensions.json` without replacing your other settings:

  ```json
  {
    "enableCustomFooter": false
  }
  ```

  This disables only CC's footer, leaving its other features enabled.
- Disable any other extension that calls `ctx.ui.setFooter()`.

## Try locally

```bash
git clone https://github.com/Moozy23232/pi-exts.git
cd pi-exts
git switch feat/codex-fast-provider-only
npm ci
pi --no-extensions -e ./extensions/local-footer.ts -e ./extensions/codex-fast.ts
```

Pi loads the TypeScript file directly; no build step is required. Installing the
package does not change your model configuration or configure CC automatically.

## Development

```bash
npm ci
npm test
```

Tests use local package dependencies, temporary Git repositories, and mocked Pi
contexts. They do not require a globally installed `pi`, credentials, or model API
calls. Each extension remains a standalone TypeScript file.

Use [Conventional Commits](https://www.conventionalcommits.org/), for example:

```text
feat(footer): add minimal context and git status footer
fix(footer): handle detached HEAD
```

## Layout

```text
extensions/local-footer.ts      # Footer implementation
extensions/codex-fast.ts        # Standalone Codex priority toggle
tests/local-footer.test.mjs     # Rendering, context, Git and lifecycle tests
tests/codex-fast.test.mjs        # Commands, persistence, payload and safety tests
docs/local-footer.md            # Footer behavior and indicator reference
docs/codex-fast.md              # Fast commands, configuration and safety
```

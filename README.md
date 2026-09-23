# pi-exts

Personal extensions for [Pi coding agent](https://pi.dev/).

## Extensions

| Extension | Description |
| --- | --- |
| [Local footer](docs/local-footer.md) | Working directory, Git status, current model, thinking level and live context usage. No costs or session names. |

```text
~/work/demo · git main ↑1 ↓2 · S2 M1 ?3
example/Example Model · high · █░░░░░░░░░ 128k/1M (12.8%)
```

## Install

Requires Pi and Node.js 22.19.0 or newer. Git must be on `PATH` for repository status.
Tested with Pi 0.87.1.

```bash
pi install git:github.com/Moozy23232/pi-exts@feat/local-footer
```

The command selects the initial feature branch. To use the repository's default
branch instead, omit `@feat/local-footer` once the extension is available there.
Run `/reload` in an existing Pi session after installation.

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
git switch feat/local-footer
npm ci
pi --no-extensions -e ./extensions/local-footer.ts
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
calls. The extension itself remains a single file in `extensions/local-footer.ts`.

Use [Conventional Commits](https://www.conventionalcommits.org/), for example:

```text
feat(footer): add minimal context and git status footer
fix(footer): handle detached HEAD
```

## Layout

```text
extensions/local-footer.ts      # Single-file implementation
tests/local-footer.test.mjs     # Rendering, context, Git and lifecycle tests
docs/local-footer.md            # Behavior and indicator reference
```

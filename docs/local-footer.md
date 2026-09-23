# Local footer

Implementation: [`extensions/local-footer.ts`](../extensions/local-footer.ts).
See the [installation instructions](../README.md#install) for package setup and
avoiding duplicate footer instances.

If you use CC, disable its footer with `"enableCustomFooter": false` in
`~/.pi/agent/pi-cc-extensions.json`. Its other features remain unchanged.
This extension has no runtime dependency on CC.
Run `/reload` after editing the extension or the configuration.

Example (illustrative values):

```text
~/work/demo · git main ↑1 ↓2 · S2 M1 ?3
example/Example Model · high · █░░░░░░░░░ 128k/1M (12.8%)
```

- CWD comes from Pi's extension context, with HOME shortened to `~`. Long paths
  retain their tail. A `cd` inside a tool subprocess does not change Pi's own CWD.
- Model includes provider and display name; thinking follows Pi's current level.
  Only the level is shown (no `think` label); models without reasoning support
  show `n/a`.
- Context shows the gauge and `used/limit (percent)` without a `ctx` label.
  It uses live `ctx.getContextUsage()`, not cumulative token usage. The numerator
  is Pi's estimate of the current context; the denominator is the currently
  selected model's configured `contextWindow`, not a hardcoded 1M. Both the gauge
  and percentage recalculate when the model changes. For example, the same 100k
  tokens show 10% of 1M or 50% of 200k. The extension does not discover the server's
  true limit; an incorrect model configuration must be corrected in `models.json`.
  Unknown usage (including after compaction) shows an empty gauge and `?`, not a
  fake 0%.
- The gauge has 10 cells. It turns warning-colored at 80% and red at 95%.
  The gauge clamps to 100%, but the numeric percentage can show over-limit usage.
- Git: `S` = staged paths; `M` = modified paths; `?` = untracked paths;
  `!` = conflicted paths. A file can be both staged and modified.
  Untracked directories may count as one path. Counts are not added/deleted lines.
- `↑` / `↓` count commits relative to the locally known upstream. No fetch occurs.
  `clean` means no working-tree changes, not necessarily synced with the upstream.
  Detached HEAD shows `@<short SHA>`. Non-repositories omit Git; `git ?` means the
  status check failed/timed out, not that the tree is clean.
- Git refreshes on tool completion/branch changes and every 5 seconds for external
  changes. Checks are asynchronous, read-only (`--no-optional-locks`), bounded to
  3 seconds / 2 MiB output, and cancelled when the footer is disposed.
- Labels are English, with no fee, session-name or third-party status chips.
  No Nerd Font is required. Whole fields wrap on narrow terminals; an individual
  field wider than the terminal is truncated safely by visible columns.
- In print/JSON/RPC mode, this extension does not install a footer or start Git polling.

Tests (no model calls):

```bash
npm test
```

To switch back to CC, disable/remove the local extension first, re-enable CC's
custom footer in `/ccstyle`, then `/reload`. Keep only one footer owner enabled.

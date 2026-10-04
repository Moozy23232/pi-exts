/*
 * Codex Fast helpers and command adapted from open-tui-custom.
 * MIT License
 * Copyright (c) 2026 pi-open-tui contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

/** Gate only on the official Codex provider; model IDs are intentionally unrestricted. */
export function supportsCodexFast(provider: string | undefined): boolean {
  return provider === 'openai-codex';
}

export function applyCodexFastTier<T>(payload: T): T {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  return { ...payload, service_tier: 'priority' } as T;
}

function notify(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error'): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.error(`[codex-fast] ${level}: ${message}`); // Never contaminate JSON/RPC stdout.
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadEnabled(path: string, ctx: ExtensionContext): boolean {
  try {
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof config !== 'object' || config === null || Array.isArray(config)
      || typeof (config as { enabled?: unknown }).enabled !== 'boolean') {
      throw new Error('expected an object with a boolean enabled field');
    }
    return (config as { enabled: boolean }).enabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      notify(ctx, `Cannot load ${path}: ${errorText(error)}. Codex Fast defaults to off.`, 'warning');
    }
    return false;
  }
}

function saveEnabled(agentDir: string, path: string, enabled: boolean): void {
  mkdirSync(agentDir, { recursive: true });
  // A private temporary directory on the same filesystem makes rename atomic.
  const temporaryDir = mkdtempSync(join(agentDir, '.codex-fast-'));
  try {
    const temporaryPath = join(temporaryDir, 'config.json');
    writeFileSync(temporaryPath, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    // Cleanup must not turn a committed rename into an apparent failed save.
    try { rmSync(temporaryDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export default function codexFast(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const path = join(agentDir, 'codex-fast.json');
  let enabled = false;

  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.mode === 'tui' && ctx.hasUI) {
      ctx.ui.setStatus('codex-fast', enabled && supportsCodexFast(ctx.model?.provider) ? 'fast' : undefined);
    }
  };

  pi.on('session_start', (_event, ctx) => {
    enabled = loadEnabled(path, ctx);
    updateStatus(ctx);
  });
  pi.on('model_select', (_event, ctx) => updateStatus(ctx));
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode === 'tui' && ctx.hasUI) ctx.ui.setStatus('codex-fast', undefined);
  });

  pi.on('before_provider_request', (event, ctx) => {
    if (!enabled || !supportsCodexFast(ctx.model?.provider)) return;
    return applyCodexFastTier(event.payload);
  });

  pi.registerCommand('fast', {
    description: 'Request Codex priority tier: /fast on|off|status (higher credit usage)',
    getArgumentCompletions: prefix => {
      const matches = ['on', 'off', 'status'].filter(action => action.startsWith(prefix.trim().toLowerCase()));
      return matches.length ? matches.map(action => ({ value: action, label: action })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || 'status';
      if (action === 'on' || action === 'off') {
        const nextEnabled = action === 'on';
        try {
          saveEnabled(agentDir, path, nextEnabled);
        } catch (error) {
          notify(ctx, `Cannot save ${path}: ${errorText(error)}. Codex Fast remains ${enabled ? 'on' : 'off'}.`, 'error');
          return;
        }
        enabled = nextEnabled;
        updateStatus(ctx);
        notify(ctx, enabled
          ? 'Codex Fast on: priority requested (service_tier=priority) for all openai-codex models; server acceptance is not guaranteed. Higher credit usage applies.'
          : 'Codex Fast off: this extension will not request priority.', enabled ? 'warning' : 'info');
        return;
      }
      if (action === 'status') {
        const supported = supportsCodexFast(ctx.model?.provider);
        const applicability = supported
          ? (enabled ? 'priority requested for the current model (openai-codex; no model restrictions)' : 'current provider is openai-codex; no model restrictions')
          : 'current provider is not openai-codex; no priority requested';
        notify(ctx, `Codex Fast: ${enabled ? 'on' : 'off'} (${applicability}). Server acceptance is not guaranteed.`, 'info');
        return;
      }
      notify(ctx, 'Usage: /fast on | /fast off | /fast status', 'warning');
    },
  });
}

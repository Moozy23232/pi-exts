/**
 * Personal footer: cwd, model, thinking, optional Codex fast request, context and Git.
 * Disable pi-cc-extensions' enableCustomFooter before loading this extension.
 * Git counts are paths, not changed lines: S staged, M modified, ? untracked, ! conflicts.
 */
import type { ContextUsage, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";

export interface GitStatus {
	branch: string;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
}

type GitState =
	| { kind: "loading" | "none" | "error" }
	| { kind: "repo"; status: GitStatus; stale?: boolean };

type FooterTheme = Pick<Theme, "fg" | "getThinkingBorderColor">;

export function parseGitStatus(output: string): GitStatus {
	const result: GitStatus = {
		branch: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0,
	};
	let oid = "";
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.startsWith("# branch.head ")) result.branch = record.slice(14);
		else if (record.startsWith("# branch.oid ")) oid = record.slice(13);
		else if (record.startsWith("# branch.ab ")) {
			const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); }
		} else if (record.startsWith("? ")) result.untracked++;
		else if (record.startsWith("u ")) result.conflicts++;
		else if (record.startsWith("1 ") || record.startsWith("2 ")) {
			const [, xy, sub] = record.split(" ", 3);
			if (xy[0] !== ".") result.staged++;
			if (xy[1] !== "." || (sub.startsWith("S") && sub.slice(1) !== "...")) result.modified++;
			// With -z, a rename/copy has a second NUL-delimited *path*, not a status record.
			if (record.startsWith("2 ")) i++;
		}
	}
	if (result.branch === "(detached)") result.branch = `@${oid.slice(0, 7)}`;
	return result;
}

function safeText(text: string): string {
	return stripTerminalSequences(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

export function displayPath(cwd: string, width: number, home = homedir()): string {
	if (width <= 0) return "";
	const path = safeText(cwd === home ? "~" : cwd.startsWith(`${home}${sep}`) ? `~${cwd.slice(home.length)}` : cwd);
	const length = visibleWidth(path);
	if (length <= width) return path;
	// Keep the useful tail; use terminal columns rather than JS string length.
	return `…${sliceByColumn(path, length - width + 1, Math.max(0, width - 1), true)}`;
}

function formatTokens(value: number): string {
	if (value < 1_000) return `${Math.round(value)}`;
	const unit = value >= 1_000_000 ? 1_000_000 : 1_000;
	return `${Number((value / unit).toFixed(1))}${unit === 1_000 ? "k" : "M"}`;
}

export function contextLabel(usage: ContextUsage | undefined, fallbackWindow = 0): string {
	const window = usage?.contextWindow ?? fallbackWindow;
	const tokens = usage?.tokens;
	const known = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
	const limit = window > 0 && Number.isFinite(window) ? formatTokens(window) : "?";
	const percent = known && window > 0 ? tokens / window * 100 : null;
	return `${known ? formatTokens(tokens) : "?"}/${limit}${percent === null ? "" : ` (${percent.toFixed(1)}%)`}`;
}

/** Wrap whole chips before truncating an individual oversized one. */
function pack(chips: string[], width: number, separator: string): string[] {
	const lines: string[] = [];
	let line = "";
	for (const chip of chips) {
		const next = line ? line + separator + chip : chip;
		if (line && visibleWidth(next) > width) {
			lines.push(line);
			line = truncateToWidth(chip, width);
		} else line = truncateToWidth(next, width);
	}
	if (line) lines.push(line);
	return lines;
}

export function renderFooter(
	width: number,
	ctx: Pick<ExtensionContext, "cwd" | "model" | "getContextUsage">,
	thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>,
	git: GitState,
	theme: FooterTheme,
	fastRequested: boolean = false,
	// An unavailable branch hint is not proof that the directory is outside Git.
	branchHint?: string | null,
): string[] {
	if (width <= 0) return [];
	const separator = theme.fg("dim", " · ");
	const hint = branchHint == null ? undefined : safeText(branchHint) || undefined;
	const location = [theme.fg("accent", displayPath(ctx.cwd, width))];
	if (git.kind === "repo") {
		const s = git.status;
		const branch = safeText(s.branch) || "HEAD";
		// A detached hint has no SHA; keep the snapshot's short SHA until refreshed.
		const sameBranch = hint == null || (hint === "detached" ? s.branch.startsWith("@") : branch === hint);
		if (!sameBranch) {
			// Never show the previous branch's counts against the newly reported branch.
			location.push(theme.fg(git.stale ? "warning" : "muted", `git ${hint} status ${git.stale ? "?" : "…"}`));
		} else {
			const tracking = `${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}`;
			location.push(theme.fg("muted", `git ${branch}${tracking}`));
			const changes = [
				s.staged ? theme.fg("success", `S${s.staged}`) : "",
				s.modified ? theme.fg("warning", `M${s.modified}`) : "",
				s.untracked ? theme.fg("muted", `?${s.untracked}`) : "",
				s.conflicts ? theme.fg("error", `!${s.conflicts}`) : "",
			].filter(Boolean);
			if (changes.length) location.push(changes.join(" "));
			// A stale snapshot cannot claim the working tree is currently clean.
			else if (!git.stale) location.push(theme.fg("success", "clean"));
			if (git.stale) location.push(theme.fg("warning", "stale"));
		}
	} else if (git.kind !== "none") {
		if (hint !== undefined) {
			location.push(theme.fg(git.kind === "error" ? "warning" : "muted", `git ${hint} status ${git.kind === "error" ? "?" : "…"}`));
		} else if (git.kind === "loading") location.push(theme.fg("dim", "git …"));
		else if (git.kind === "error") location.push(theme.fg("warning", "git ?"));
	}
	const model = ctx.model;
	const usage = ctx.getContextUsage();
	const tokens = usage?.tokens;
	const percent = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 && usage && usage.contextWindow > 0
		? tokens / usage.contextWindow * 100 : 0;
	// Match the original CC footer's 10-cell gauge and 80%/95% warning thresholds.
	const contextColor = percent >= 95 ? "error" : percent >= 80 ? "warning" : "accent";
	const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10);
	const gauge = theme.fg(contextColor, "█".repeat(filled)) + theme.fg("dim", "░".repeat(10 - filled));
	const details = [
		theme.fg("accent", model ? safeText(`${model.provider}/${model.name || model.id}`) : "no model"),
		model?.reasoning
			? theme.getThinkingBorderColor(thinking)(thinking)
			: theme.fg("dim", "n/a"),
		...(fastRequested && model?.provider === "openai-codex" ? [theme.fg("accent", "fast")] : []),
		gauge + theme.fg("muted", ` ${contextLabel(usage, model?.contextWindow)}`),
	];
	return [...pack(location, width, separator), ...pack(details, width, separator)];
}

export default function (pi: ExtensionAPI) {
	let currentContext: ExtensionContext | undefined;
	let repaint: (() => void) | undefined;
	let refreshGit: ((cwdOnly?: boolean) => void) | undefined;
	let disposeFooter: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		disposeFooter?.();
		currentContext = ctx;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		const footerCwd = ctx.cwd;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const POLL_MS = 15_000;
			const COOLDOWN_MS = 5_000;
			let git: GitState = { kind: "loading" };
			let disposed = false;
			let running = false;
			let pending = false;
			let controller: AbortController | undefined;
			let generation = 0;
			let delay: ReturnType<typeof setTimeout> | undefined;
			let lastCwd = ctx.cwd;
			let lastFinished = 0;
			const currentCwd = () => currentContext?.cwd ?? ctx.cwd;
			const requestRender = () => { if (!disposed) tui.requestRender(); };
			// Pi caches this hint for the footer's own cwd; never reuse it for another directory.
			const hint = () => currentCwd() === footerCwd ? footerData.getGitBranch?.() : undefined;
			let lastBranchHint = hint();

			const clearDelay = () => {
				if (delay === undefined) return;
				clearTimeout(delay);
				delay = undefined;
			};
			const cancel = () => {
				if (!running) return;
				generation++;
				controller?.abort();
				controller = undefined;
				running = false;
			};
			const syncCwd = () => {
				const cwd = currentCwd();
				if (cwd === lastCwd) return;
				lastCwd = cwd;
				git = { kind: "loading" };
				pending = false;
				lastFinished = 0; // A directory change bypasses the cooldown.
				clearDelay();
				cancel();
				requestRender();
			};
			const schedule = (ms: number) => {
				if (disposed || delay !== undefined) return;
				delay = setTimeout(() => { delay = undefined; request(); }, ms);
				delay.unref();
			};
			const start = () => {
				if (disposed || running) return;
				clearDelay();
				running = true;
				pending = false;
				const cwd = currentCwd();
				const id = ++generation;
				const abort = new AbortController();
				controller = abort;
				execFile("git", ["--no-optional-locks", "-C", cwd, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], {
					encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
					signal: abort.signal, env: { ...process.env, LC_ALL: "C" },
				}, (error, stdout, stderr) => {
					if (disposed || id !== generation) return;
					running = false;
					controller = undefined;
					lastFinished = Date.now();
					if (cwd !== currentCwd()) {
						// Never publish a result from the previous directory; restart in the new one.
						syncCwd();
						start();
						return;
					}
					if (!error) git = { kind: "repo", status: parseGitStatus(stdout) };
					else if (/not a git repository/i.test(stderr)) git = { kind: "none" };
					// Keep verified counts, but `clean` is no longer current.
					else git = git.kind === "repo" ? { kind: "repo", status: git.status, stale: true } : { kind: "error" };
					requestRender();
					if (pending) { pending = false; schedule(COOLDOWN_MS); }
				});
			};
			const request = (cwdOnly = false) => {
				if (disposed || (cwdOnly && currentCwd() === lastCwd)) return;
				syncCwd();
				if (running) { pending = true; return; }
				const wait = lastFinished + COOLDOWN_MS - Date.now();
				if (wait > 0) schedule(wait);
				else start();
			};

			const unsubscribe = footerData.onBranchChange(() => {
				if (disposed) return;
				// A missing hint can be a transient HEAD read failure, not a checkout.
				const branch = hint();
				if (branch && branch !== lastBranchHint) {
					lastBranchHint = branch;
					git = { kind: "loading" };
					cancel(); // Do not publish a query started on the previous branch.
				}
				requestRender();
				request();
			});
			const poll = setInterval(request, POLL_MS);
			poll.unref();
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				clearInterval(poll);
				clearDelay();
				unsubscribe();
				cancel();
				if (disposeFooter === dispose) {
					disposeFooter = undefined;
					refreshGit = undefined;
					repaint = undefined;
				}
			};
			disposeFooter = dispose;
			refreshGit = request;
			repaint = requestRender;
			request();

			return {
				render: (width: number) => renderFooter(
					width, currentContext ?? ctx, pi.getThinkingLevel(),
					currentCwd() === lastCwd ? git : { kind: "loading" }, theme,
					footerData.getExtensionStatuses().get("codex-fast") === "fast", hint(),
				),
				invalidate() {}, // No themed strings or layout cached across renders.
				dispose,
			};
		});
	});

	const update = (_event: unknown, ctx: ExtensionContext) => {
		currentContext = ctx;
		refreshGit?.(true);
		repaint?.();
	};
	const updateGit = (_event: unknown, ctx: ExtensionContext) => {
		currentContext = ctx;
		refreshGit?.();
		repaint?.();
	};
	const readOnlyTools = new Set(["read", "grep", "find", "ls"]);
	pi.on("model_select", update);
	pi.on("thinking_level_select", update);
	pi.on("message_update", update);
	pi.on("message_end", update);
	pi.on("session_compact", update);
	pi.on("session_tree", updateGit);
	pi.on("tool_execution_end", (event, ctx) => {
		// Read-only tools repaint; a CWD change still needs its first Git snapshot.
		if (readOnlyTools.has(event.toolName)) update(event, ctx);
		else updateGit(event, ctx);
	});
	pi.on("agent_end", updateGit);
	pi.on("session_shutdown", () => { disposeFooter?.(); currentContext = undefined; });
}

// Run: npm test (no global Pi installation or API calls required).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createJiti } from 'jiti';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

const jiti = createJiti(import.meta.url);
const footer = await jiti.import('../extensions/local-footer.ts');
const plainTheme = { fg: (_color, text) => text, getThinkingBorderColor: () => text => text };
const ansiTheme = { fg: (_color, text) => `\x1b[32m${text}\x1b[0m`, getThinkingBorderColor: () => text => `\x1b[34m${text}\x1b[0m` };
const model = { provider: 'example', name: 'Example Model', id: 'test', contextWindow: 1_000_000, reasoning: true };
const ctx = (overrides = {}) => ({
  cwd: '/home/demo/work/project', model,
  getContextUsage: () => ({ tokens: 128000, contextWindow: 1000000, percent: 12.8 }),
  ...overrides,
});
const repoState = (overrides = {}) => ({ kind: 'repo', status: {
  branch: 'main', ahead: 1, behind: 2, staged: 2, modified: 1, untracked: 3, conflicts: 0, ...overrides,
} });
const git = (dir, ...args) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' });
const status = dir => footer.parseGitStatus(git(dir, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'));
const tempRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-footer-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Footer Test');
  git(dir, 'config', 'user.email', 'footer@example.invalid');
  return dir;
};

// Poll only our own local asynchronous component, not external services.
// Git refreshes are intentionally coalesced (>=5s) after a completed query.
const until = async predicate => {
  const end = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Footer did not refresh in time');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

function harness(context, { branch = () => null } = {}) {
  const handlers = new Map();
  let component, renders = 0, unsubscribes = 0, level = 'high';
  let statuses = new Map(), statusReads = 0;
  const branchListeners = new Set();
  const requestRender = () => renders++;
  const pi = { on: (event, handler) => handlers.set(event, handler), getThinkingLevel: () => level };
  context.mode ??= 'tui';
  context.hasUI ??= true;
  context.ui = {
    setStatus: (key, text) => {
      statuses = new Map(statuses);
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      requestRender(); // Pi's host requests a render on every setStatus().
    },
    setFooter: factory => {
      component?.dispose();
      component = factory({ requestRender }, plainTheme, {
        onBranchChange: handler => {
          branchListeners.add(handler);
          return () => { branchListeners.delete(handler); unsubscribes++; };
        },
        getGitBranch: () => branch(),
        getExtensionStatuses: () => { statusReads++; return statuses; },
      });
    },
  };
  footer.default(pi);
  return {
    fire: (event, eventContext = context) => handlers.get(event)?.({}, eventContext),
    emit: (event, payload = {}, eventContext = context) => handlers.get(event)?.({ ...payload }, eventContext),
    branchChanged: () => { for (const handler of [...branchListeners]) handler(); },
    lines: () => component?.render(160) ?? [],
    dispose: () => component?.dispose(),
    thinking: value => { level = value; },
    get renders() { return renders; },
    get statusReads() { return statusReads; },
    get unsubscribes() { return unsubscribes; },
    get branchSubscriptions() { return branchListeners.size; },
  };
}

// The Jiti-loaded module may retain its execFile reference. Keep one dispatcher
// for this test process and restore its real-Git path after every mocked test.
const childProcess = createRequire(import.meta.url)('node:child_process');
const realExecFile = childProcess.execFile;
let gitQueryHandler = null;
childProcess.execFile = (file, args, options, callback) => gitQueryHandler && file === 'git'
  ? gitQueryHandler(file, args, options, callback)
  : realExecFile(file, args, options, callback);
syncBuiltinESMExports();

// Deterministic stand-in for `git status`: the test answers each child itself.
function mockGit(t) {
  assert.equal(gitQueryHandler, null, 'previous Git mock was restored');
  const calls = [];
  const settle = (call, { stdout = '', stderr = '', error = null } = {}) => {
    if (call.settled) return;
    call.settled = true;
    call.callback(error, stdout, stderr);
  };
  gitQueryHandler = (file, args, options, callback) => {
    const call = { file, args, options, callback, aborted: false, settled: false };
    calls.push(call);
    options?.signal?.addEventListener?.('abort', () => {
      call.aborted = true;
      // Real execFile answers an aborted child with an AbortError.
      queueMicrotask(() => settle(call, { error: Object.assign(new Error('aborted'), { name: 'AbortError' }) }));
    }, { once: true });
    return { pid: 4242, on() {}, kill() {} };
  };
  t.after(() => { gitQueryHandler = null; });
  return { calls, reply: settle };
}

const CLOCK_START = 1_700_000_000_000; // Realistic epoch: cooldowns compare absolute times.
const flush = () => new Promise(resolve => setImmediate(resolve));
const textOf = h => h.lines().join('\n');
const porcelain = (branch = 'main', { ahead = 0, behind = 0, changes = '' } = {}) =>
  `# branch.head ${branch}\0# branch.ab +${ahead} -${behind}\0${changes}`;

test('context uses live occupancy, preserves unknown after compaction and zero', () => {
  assert.equal(footer.contextLabel({ tokens: 128000, contextWindow: 1e6, percent: 12.8 }), '128k/1M (12.8%)');
  assert.equal(footer.contextLabel({ tokens: null, contextWindow: 1e6, percent: null }), '?/1M');
  assert.equal(footer.contextLabel(undefined, 262144), '?/262.1k');
  assert.equal(footer.contextLabel({ tokens: 0, contextWindow: 200000, percent: 0 }), '0/200k (0.0%)');
  assert.equal(footer.contextLabel({ tokens: 210000, contextWindow: 200000, percent: 105 }), '210k/200k (105.0%)');
});

test('path uses HOME boundary and terminal-safe tail truncation', () => {
  assert.equal(footer.displayPath('/home/demo', 30, '/home/demo'), '~');
  assert.equal(footer.displayPath('/home/demo/a', 30, '/home/demo'), '~/a');
  assert.equal(footer.displayPath('/home/demolition', 30, '/home/demo'), '/home/demolition');
  assert.equal(footer.displayPath('/', 10, '/home/demo'), '/');
  assert.match(footer.displayPath('/some/long/path/project', 10, '/home/demo'), /project$/);
  assert.doesNotMatch(footer.displayPath('/tmp/\x1b[31mred\nline\x1b[0m', 50), /[\x00-\x1f]/);
});

test('layout keeps fields, wraps narrow terminals, has no costs or session name', () => {
  const text = footer.renderFooter(160, ctx(), 'high', repoState(), plainTheme).join('\n');
  for (const value of ['project', 'git main ↑1 ↓2', 'S2 M1 ?3', 'example/Example Model', ' · high · ', '█░░░░░░░░░ 128k/1M (12.8%)']) assert.ok(text.includes(value), value);
  assert.equal(text.split('\n').length, 2);
  assert.doesNotMatch(text, /\$|费用|session|配置|\bthink\b|\bctx\b/);
  for (let width = 1; width <= 180; width++) {
    const lines = footer.renderFooter(width, ctx({ cwd: '/很长的目录/项目😀/测试' }), 'max', repoState({ branch: '很长的分支名😀' }), ansiTheme);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at width=${width}`);
    assert.ok(lines.every(line => !stripTerminalSequences(line).includes('\n')));
  }
  assert.deepEqual(footer.renderFooter(0, ctx(), 'off', { kind: 'none' }, plainTheme), []);
  assert.match(footer.renderFooter(80, ctx({ model: { ...model, reasoning: false } }), 'high', { kind: 'none' }, plainTheme).join('\n'), / · n\/a · /);
  assert.doesNotMatch(text, /\p{Script=Han}/u);
  assert.doesNotMatch(footer.renderFooter(160, ctx(), 'high', { kind: 'error' }, plainTheme).join('\n'), /clean/);
});

test('fast chip is opt-in, provider-exact, model-ID independent, and accent highlighted', () => {
  const codex = ctx({ model: { ...model, provider: 'openai-codex', id: 'arbitrary-future-model' } });
  const render = (context, ...args) => footer.renderFooter(180, context, 'high', { kind: 'none' }, plainTheme, ...args).join('\n');
  assert.doesNotMatch(render(codex), /\bfast\b/);
  assert.doesNotMatch(render(codex, false), /\bfast\b/);
  assert.match(render(codex, true), / · high · fast · █░{9}/);
  assert.match(render(ctx({ model: { ...codex.model, reasoning: false } }), true), / · n\/a · fast · /);
  for (const provider of ['example', 'openai', 'OpenAI-Codex', 'openai-codex-proxy', 'openai-codex ']) {
    assert.doesNotMatch(render(ctx({ model: { ...model, provider } }), true), /\bfast\b/);
  }
  assert.doesNotMatch(render(ctx({ model: undefined }), true), /\bfast\b/);
  const colors = [];
  const theme = { ...plainTheme, fg: (color, text) => { colors.push([color, text]); return text; } };
  footer.renderFooter(180, codex, 'high', { kind: 'none' }, theme, true);
  assert.deepEqual(colors.filter(([, text]) => text === 'fast'), [['accent', 'fast']]);
});

test('fast-enabled layout fits widths 1..180 with long Unicode paths, branches and models', () => {
  const context = ctx({
    cwd: '/很长的目录/项目😀/e\u0301'.repeat(10),
    model: { ...model, provider: 'openai-codex', name: '很长的模型😀e\u0301'.repeat(10) },
  });
  for (let width = 1; width <= 180; width++) {
    const lines = footer.renderFooter(width, context, 'max', repoState({ branch: '很长的分支😀e\u0301'.repeat(10) }), ansiTheme, true);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at width=${width}`);
    assert.ok(lines.every(line => !stripTerminalSequences(line).includes('\n')));
    if (width >= 4) assert.match(lines.map(stripTerminalSequences).join('\n'), /\bfast\b/);
  }
});

test('live status changes request rendering and are read fresh; provider switches guard stale status', async () => {
  const dir = tempRepo();
  const context = ctx({ cwd: dir, model: { ...model, provider: 'openai-codex', id: 'any-id' } });
  const h = harness(context);
  const text = () => h.lines().join('\n');
  try {
    h.fire('session_start');
    await until(() => text().includes('clean'));
    assert.doesNotMatch(text(), /\bfast\b/); // Standalone: no status publisher.
    context.ui.setStatus('unrelated', 'fast');
    assert.doesNotMatch(text(), /\bfast\b/);
    for (const value of ['fast', undefined, 'off', 'FAST', '', 'fast', undefined, 'fast']) {
      const renders = h.renders;
      const reads = h.statusReads;
      context.ui.setStatus('codex-fast', value);
      assert.equal(h.renders, renders + 1);
      assert.equal(/ · high · fast · /.test(text()), value === 'fast');
      assert.equal(h.statusReads, reads + 1);
    }
    // Use fresh event contexts, not mutations of the context captured at startup.
    for (const selectedModel of [{ ...model, provider: 'openai' }, undefined, context.model]) {
      const renders = h.renders;
      h.fire('model_select', { ...context, model: selectedModel });
      assert.equal(h.renders, renders + 1);
      assert.equal(/\bfast\b/.test(text()), selectedModel?.provider === 'openai-codex');
    }
    context.ui.setStatus('codex-fast', undefined);
    assert.doesNotMatch(text(), /\bfast\b/);
  } finally { h.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('10-cell context gauge preserves 80/95 thresholds, unknown, and over-limit usage', () => {
  for (const [percent, color, filled] of [[0, 'accent', 0], [79, 'accent', 8], [80, 'warning', 8], [95, 'error', 10], [120, 'error', 10]]) {
    const colors = [];
    const theme = { ...plainTheme, fg: (color, text) => { colors.push([color, text]); return text; } };
    const context = ctx({ getContextUsage: () => ({ tokens: percent * 10000, contextWindow: 1e6, percent }) });
    const text = footer.renderFooter(160, context, 'high', { kind: 'none' }, theme).join('\n');
    assert.ok(text.includes('█'.repeat(filled) + '░'.repeat(10-filled)));
    assert.ok(colors.some(([c, text]) => c === color && text === '█'.repeat(filled)));
    assert.ok(text.includes(`(${percent.toFixed(1)}%)`));
  }
  const text = footer.renderFooter(160, ctx({ getContextUsage: () => undefined }), 'off', { kind: 'none' }, plainTheme).join('\n');
  assert.match(text, /░{10} \?\/1M/);
  assert.doesNotMatch(text, /0\.0%/);
});

test('context denominator, percentage and gauge follow the live model window', () => {
  const context = ctx();
  let tokens = 100000;
  context.getContextUsage = () => ({ tokens, contextWindow: context.model.contextWindow, percent: tokens / context.model.contextWindow * 100 });
  for (const [window, label, gauge] of [
    [1_000_000, '100k/1M (10.0%)', '█░░░░░░░░░'],
    [200_000, '100k/200k (50.0%)', '█████░░░░░'],
    [262_144, '100k/262.1k (38.1%)', '████░░░░░░'],
  ]) {
    context.model = { ...model, contextWindow: window };
    const text = footer.renderFooter(160, context, 'high', { kind: 'none' }, plainTheme).join('\n');
    assert.ok(text.includes(`${gauge} ${label}`), text);
  }
  tokens = null;
  assert.match(footer.renderFooter(160, context, 'high', { kind: 'none' }, plainTheme).join('\n'), /░{10} \?\/262\.1k/);
  context.getContextUsage = () => undefined;
  assert.match(footer.renderFooter(160, context, 'high', { kind: 'none' }, plainTheme).join('\n'), /░{10} \?\/262\.1k/);
});

test('porcelain parser handles rename source records, conflict, detached, tracking, submodules', () => {
  const raw = [
    '# branch.oid abcdef123456', '# branch.head (detached)', '# branch.ab +3 -4',
    '1 M. N... 100644 100644 100644 a b staged',
    '1 .M N... 100644 100644 100644 a b modified',
    '1 MM N... 100644 100644 100644 a b both',
    '2 R. N... 100644 100644 100644 a b R100 target', '? fake-source-name',
    'u UU N... 100644 100644 100644 100644 a b c conflict',
    '? new\nfile', '1 .. S..U 160000 160000 160000 a b submodule', '',
  ].join('\0');
  assert.deepEqual(footer.parseGitStatus(raw), {
    branch: '@abcdef1', ahead: 3, behind: 4, staged: 3, modified: 3, untracked: 1, conflicts: 1,
  });
});

test('actual Git: unborn, clean, both staged/unstaged, newline filenames, rename, detached, worktree', () => {
  const dir = tempRepo();
  const worktree = `${dir}-worktree`;
  try {
    assert.equal(status(dir).branch, 'main');
    writeFileSync(join(dir, 'file'), 'one\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial');
    assert.deepEqual(status(dir), { branch: 'main', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 });
    writeFileSync(join(dir, 'file'), 'two\n'); git(dir, 'add', 'file');
    writeFileSync(join(dir, 'file'), 'three\n');
    writeFileSync(join(dir, 'new\n? weird'), 'new');
    assert.equal(status(dir).staged, 1); assert.equal(status(dir).modified, 1); assert.equal(status(dir).untracked, 1);
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'second');
    git(dir, 'mv', 'new\n? weird', 'renamed');
    assert.equal(status(dir).staged, 1); assert.equal(status(dir).untracked, 0);
    git(dir, 'commit', '-qam', 'rename'); git(dir, 'checkout', '--detach', '-q');
    assert.match(status(dir).branch, /^@[0-9a-f]{7}$/);
    git(dir, 'worktree', 'add', '-q', '-b', 'other', worktree);
    assert.equal(status(worktree).branch, 'other');
  } finally { rmSync(worktree, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('actual Git: divergence from local upstream and merge conflict', () => {
  const dir = tempRepo();
  try {
    writeFileSync(join(dir, 'file'), 'base\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'other');
    writeFileSync(join(dir, 'file'), 'other\n'); git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'file'), 'main\n'); git(dir, 'commit', '-qam', 'main');
    git(dir, 'branch', '--set-upstream-to=other', 'main');
    assert.equal(status(dir).ahead, 1); assert.equal(status(dir).behind, 1);
    assert.throws(() => git(dir, 'merge', 'other'));
    assert.equal(status(dir).conflicts, 1);
    assert.equal(status(dir).staged, 0); assert.equal(status(dir).modified, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lifecycle: model/thinking/context refresh, external edit, session restart, cleanup', async () => {
  const dir = tempRepo();
  const context = ctx({ cwd: dir });
  const h = harness(context);
  try {
    h.fire('session_start');
    await until(() => h.lines().join('\n').includes('clean'));
    writeFileSync(join(dir, 'new'), 'new'); h.fire('tool_execution_end');
    await until(() => h.lines().join('\n').includes('?1'));
    context.model = { ...model, name: 'Changed Model', contextWindow: 200000 };
    context.getContextUsage = () => ({ tokens: 40000, contextWindow: context.model.contextWindow, percent: 20 });
    h.fire('model_select');
    h.thinking('max'); h.fire('thinking_level_select');
    assert.match(h.lines().join('\n'), /Changed Model · max · ██░{8} 40k\/200k \(20\.0%\)/);
    context.getContextUsage = () => ({ tokens: null, contextWindow: context.model.contextWindow, percent: null }); h.fire('session_compact');
    assert.match(h.lines().join('\n'), /░{10} \?\/200k/);
    h.fire('session_start');
    assert.equal(h.unsubscribes, 1);
    await until(() => h.lines().join('\n').includes('?1'));
    h.fire('session_shutdown'); h.dispose();
    assert.equal(h.unsubscribes, 2);
    const renders = h.renders;
    h.fire('tool_execution_end');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.renders, renders);
  } finally { h.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('non-repository hides Git; shutdown during a pending child is safe; no footer in print/RPC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'footer-no-git-'));
  const h = harness(ctx({ cwd: dir }));
  try {
    h.fire('session_start'); await until(() => !/git [.…?]/u.test(h.lines().join('\n')));
    h.fire('tool_execution_end'); h.fire('session_shutdown');
    for (const mode of ['print', 'json', 'rpc']) {
      const noUi = harness(ctx({ mode, hasUI: mode === 'rpc' }));
      noUi.fire('session_start'); assert.deepEqual(noUi.lines(), []);
    }
  } finally { h.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('branch hints paint immediately and never leak stats from another branch', () => {
  const render = (git, hint) => footer.renderFooter(160, ctx(), 'high', git, plainTheme, false, hint).join('\n');
  // Pi's cached branch arrives before the slower status query.
  const pending = render({ kind: 'loading' }, 'feature');
  assert.match(pending, /git feature status …/);
  assert.doesNotMatch(pending, /\bclean\b/);
  // Legacy six-argument calls keep their exact old output.
  assert.equal(render(repoState()), footer.renderFooter(160, ctx(), 'high', repoState(), plainTheme, false).join('\n'));
  assert.match(render(repoState()), /git main ↑1 ↓2 · S2 M1 \?3/);
  // A hint for a different branch hides the previous branch's tracking and counts.
  for (const git of [repoState(), { ...repoState(), stale: true }]) {
    const text = render(git, 'feature');
    assert.match(text, /git feature status (…|\?)/);
    for (const leaked of ['↑1', '↓2', 'S2', 'M1', '?3', 'clean']) assert.ok(!text.includes(leaked), leaked);
  }
  // A failed refresh for the newly reported branch stays unknown.
  assert.match(render({ ...repoState(), stale: true }, 'feature'), /git feature status \?/);
  // Detached hints are compatible with the snapshot's @<sha>.
  const detached = render({ kind: 'repo', status: { branch: '@abcdef1', ahead: 0, behind: 0, staged: 1, modified: 0, untracked: 0, conflicts: 0 } }, 'detached');
  assert.match(detached, /git @abcdef1/);
  assert.match(detached, /S1/);
  assert.doesNotMatch(detached, /stale|status (…|\?)/);
  // null/undefined mean "no hint"; control-only hints are dropped, never rendered.
  assert.match(render(repoState(), null), /git main ↑1 ↓2/);
  assert.match(render(repoState(), undefined), /git main ↑1 ↓2/);
  assert.match(render({ kind: 'loading' }, null), /git …/);
  assert.match(render({ kind: 'error' }, null), /git \?/);
  const junk = render({ kind: 'loading' }, '\u001b[31m');
  assert.doesNotMatch(junk.replaceAll('\n', ''), /[\x00-\x1f]/); // control-only hints never reach the terminal
  assert.match(junk, /git /);
});

test('stale snapshots keep exact S/M/? counts but never claim clean', () => {
  const render = (git, hint = 'main') => footer.renderFooter(160, ctx(), 'high', git, plainTheme, false, hint).join('\n');
  const stale = render({ ...repoState(), stale: true });
  assert.match(stale, /git main ↑1 ↓2/);
  for (const kept of ['S2', 'M1', '?3']) assert.ok(stale.includes(kept), kept);
  assert.match(stale, /\bstale\b/);
  assert.doesNotMatch(stale, /\bclean\b/);
  // The previous "clean" must not survive a failed refresh.
  const cleanRepo = { kind: 'repo', status: { branch: 'main', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 } };
  assert.match(render(cleanRepo), /\bclean\b/);
  const staleClean = render({ ...cleanRepo, stale: true });
  assert.match(staleClean, /git main/);
  assert.doesNotMatch(staleClean, /\bclean\b/);
  // Without a successful snapshot, failures stay unknown and never fabricate clean.
  const failed = render({ kind: 'error' }, 'feature');
  assert.match(failed, /git feature status \?/);
  assert.doesNotMatch(failed, /clean|\bS\d|\bM\d|\?\d/);
  assert.doesNotMatch(render({ kind: 'error' }), /clean/);
  assert.doesNotMatch(render({ kind: 'none' }, null), /git/);
});

test('Git status reads start immediately, read-only tools only repaint, polling is 15s', async t => {
  const { calls, reply } = mockGit(t);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: CLOCK_START });
  t.after(() => mock.timers.reset());
  const branch = { value: 'main' };
  const h = harness(ctx({ cwd: '/repo/one' }), { branch: () => branch.value });
  try {
    h.fire('session_start');
    assert.equal(calls.length, 1); // first read is immediate
    assert.equal(calls[0].file, 'git');
    assert.deepEqual(calls[0].args, ['--no-optional-locks', '-C', '/repo/one', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
    assert.equal(calls[0].options.timeout, 10000);
    assert.match(textOf(h), /git main status …/); // hint does not wait for the status child
    reply(calls[0], { stdout: porcelain('main', { ahead: 2, changes: '? a\0' }) });
    await flush();
    assert.match(textOf(h), /git main ↑2/);
    assert.match(textOf(h), /\?1/);
    for (const toolName of ['read', 'grep', 'find', 'ls']) {
      const renders = h.renders;
      h.emit('tool_execution_end', { toolName });
      assert.ok(h.renders > renders, `${toolName} repaints`);
      assert.equal(calls.length, 1, `${toolName} must not query Git`);
    }
    mock.timers.tick(9999);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(5001);
    await flush();
    assert.equal(calls.length, 2); // 15s external-change poll
    assert.equal(calls[1].args[2], '/repo/one');
  } finally { h.dispose(); }
});

test('tool/agent/branch bursts merge into one pending refresh with a 5s cooldown', async t => {
  const { calls, reply } = mockGit(t);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: CLOCK_START });
  t.after(() => mock.timers.reset());
  const branch = { value: 'main' };
  const h = harness(ctx({ cwd: '/repo/burst' }), { branch: () => branch.value });
  try {
    h.fire('session_start');
    reply(calls[0], { stdout: porcelain('main') });
    await flush();
    mock.timers.tick(5001); // cooldown after the initial query has elapsed
    h.emit('tool_execution_end', { toolName: 'bash' });
    assert.equal(calls.length, 2);
    for (const [event, payload] of [['agent_end', {}], ['session_tree', {}], ['tool_execution_end', { toolName: 'edit' }]]) h.emit(event, payload);
    h.branchChanged();
    assert.equal(calls.length, 2); // all of them merged into one pending refresh
    reply(calls[1], { stdout: porcelain('main', { changes: '? a\0' }) });
    await flush();
    assert.equal(calls.length, 2); // no back-to-back scanning
    mock.timers.tick(4999);
    await flush();
    assert.equal(calls.length, 2);
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 3);
    reply(calls[2], { stdout: porcelain('main') });
    await flush();
    assert.match(textOf(h), /\bclean\b/);
    mock.timers.tick(4000);
    await flush();
    assert.equal(calls.length, 3); // still inside the cooldown window
    // A branch notification repaints at once and drops the old branch's stats.
    branch.value = 'feature';
    const renders = h.renders;
    h.branchChanged();
    assert.ok(h.renders > renders);
    assert.match(textOf(h), /git feature status (…|\?)/);
    assert.doesNotMatch(textOf(h), /git main|↑|↓|S\d|M\d|\?\d|\bclean\b/);
  } finally { h.dispose(); }
});

test('failed refresh keeps the snapshot as stale, never stale-clean, then recovers', async t => {
  const { calls, reply } = mockGit(t);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: CLOCK_START });
  t.after(() => mock.timers.reset());
  const branch = { value: 'main' };
  const h = harness(ctx({ cwd: '/repo/checkout' }), { branch: () => branch.value });
  try {
    h.fire('session_start');
    reply(calls[0], { stdout: porcelain('main') });
    await flush();
    assert.match(textOf(h), /\bclean\b/);
    mock.timers.tick(5001);
    h.emit('tool_execution_end', { toolName: 'write' });
    assert.equal(calls.length, 2);
    // A transient HEAD lookup failure must not discard the last successful snapshot.
    branch.value = null;
    h.branchChanged();
    assert.match(textOf(h), /git main/);
    assert.match(textOf(h), /\bclean\b/);
    reply(calls[1], { error: Object.assign(new Error('git failed'), { code: 128 }), stderr: 'fatal: unable to read' });
    await flush();
    assert.match(textOf(h), /git main/);
    assert.doesNotMatch(textOf(h), /\bclean\b/); // the old clean is not current any more
    assert.match(textOf(h), /\bstale\b/);
    mock.timers.tick(5001);
    h.emit('agent_end', {});
    assert.equal(calls.length, 3);
    reply(calls[2], { stdout: porcelain('main', { changes: '? a\0? b\0' }) });
    await flush();
    assert.match(textOf(h), /git main/);
    assert.match(textOf(h), /\?2/);
    assert.doesNotMatch(textOf(h), /\bstale\b/);
  } finally { h.dispose(); }
});

test('cwd change drops the old snapshot and in-flight result instead of painting it', async t => {
  const { calls, reply } = mockGit(t);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: CLOCK_START });
  t.after(() => mock.timers.reset());
  const branch = { value: 'main' };
  const context = ctx({ cwd: '/repo/old' });
  const h = harness(context, { branch: () => branch.value });
  try {
    h.fire('session_start');
    reply(calls[0], { stdout: porcelain('main', { changes: '? a\0? b\0? c\0' }) });
    await flush();
    assert.match(textOf(h), /\?3/);
    mock.timers.tick(5001);
    h.emit('tool_execution_end', { toolName: 'bash' });
    assert.equal(calls.length, 2); // old directory has a real in-flight query
    const oldCall = calls[1];
    context.cwd = '/repo/new';
    h.emit('tool_execution_end', { toolName: 'read' }); // even a read detects a new cwd
    assert.equal(calls.length, 3);
    assert.ok(oldCall.aborted);
    const newCall = calls[2];
    assert.equal(newCall.args[2], '/repo/new');
    oldCall.callback(null, porcelain('main', { changes: '? x\0' }), '');
    await flush();
    // The old cwd's hint and snapshot must not be reused for the new directory.
    assert.match(textOf(h), /git …/);
    for (const leak of ['?3', '?1', 'git main', 'clean']) assert.ok(!textOf(h).includes(leak), leak);
    reply(newCall, { stdout: porcelain('other') });
    await flush();
    assert.match(textOf(h), /git other/);
    assert.match(textOf(h), /\bclean\b/);
  } finally { h.dispose(); }
});

test('dispose stops polling, delayed refreshes, subscriptions and in-flight children', async t => {
  const { calls } = mockGit(t);
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: CLOCK_START });
  t.after(() => mock.timers.reset());
  const h = harness(ctx({ cwd: '/repo/dispose' }));
  try {
    h.fire('session_start');
    assert.equal(calls.length, 1);
    assert.equal(h.branchSubscriptions, 1);
    const renders = h.renders;
    h.dispose();
    assert.equal(h.unsubscribes, 1);
    assert.equal(h.branchSubscriptions, 0);
    assert.ok(calls[0].aborted, 'in-flight child aborted');
    await flush(); // the aborted child answers late
    assert.equal(h.renders, renders);
    mock.timers.tick(120000);
    await flush();
    assert.equal(calls.length, 1);
    h.emit('tool_execution_end', { toolName: 'bash' });
    h.emit('agent_end', {});
    h.branchChanged();
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(h.renders, renders);
  } finally { h.dispose(); }
});

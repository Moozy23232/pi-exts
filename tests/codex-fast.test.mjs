// Run: node --test tests/codex-fast.test.mjs (mocked Pi, no model/API calls).
import assert from 'node:assert/strict';
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJiti } from 'jiti';

const supportedModel = { provider: 'openai-codex', id: 'gpt-5.6' };

async function fixture(t, { raw, mode = 'tui', hasUI = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-fast-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent');
  const path = join(agentDir, 'codex-fast.json');
  const stub = join(root, 'pi-stub.cjs');
  writeFileSync(stub, `exports.getAgentDir = () => ${JSON.stringify(agentDir)};\n`);
  const jiti = createJiti(import.meta.url, {
    alias: { '@earendil-works/pi-coding-agent': stub },
    moduleCache: false,
    fsCache: false,
  });
  const extension = await jiti.import('../extensions/codex-fast.ts');
  const put = contents => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path, contents);
  };
  if (raw !== undefined) put(raw);
  const harness = () => {
    const handlers = new Map(), commands = new Map(), notices = [], statuses = new Map();
    const ctx = {
      mode, hasUI, model: { ...supportedModel },
      ui: {
        notify: (message, level) => notices.push({ message, level }),
        setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
      },
    };
    extension.default({
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: (name, command) => commands.set(name, command),
    });
    return {
      ctx, notices, handlers, commands, statuses,
      start: () => handlers.get('session_start')({}, ctx),
      request: payload => handlers.get('before_provider_request')({ payload }, ctx),
      command: args => commands.get('fast').handler(args, ctx),
      complete: prefix => commands.get('fast').getArgumentCompletions(prefix),
    };
  };
  return { root, agentDir, path, put, extension, harness, h: harness() };
}

const last = h => h.notices.at(-1);
const assertOff = h => assert.equal(h.request(Object.freeze({ input: [] })), undefined);
const assertOn = h => assert.deepEqual(h.request({}), { service_tier: 'priority' });

test('only openai-codex is eligible, regardless of model ID or family', async t => {
  const { extension, h } = await fixture(t, { raw: '{"enabled":true}' });
  h.start();
  // Include unknown/future names and no ID to prove there is no model gate.
  const ids = ['gpt-5.4', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.4-mini',
    'gpt-5.5-codex', 'gpt-future', 'future-model', 'codex-auto-review', 'o3', '', undefined];
  assert.equal(extension.supportsCodexFast('openai-codex'), true);
  for (const id of ids) {
    h.ctx.model = { provider: 'openai-codex', id };
    assertOn(h);
  }
  for (const provider of [undefined, '', 'openai', 'azure-openai', 'OpenAI-Codex',
    'openai-codex-proxy', ' openai-codex', 'custom', 'anthropic']) {
    assert.equal(extension.supportsCodexFast(provider), false);
    for (const id of ids) {
      h.ctx.model = { provider, id };
      assertOff(h);
    }
  }
  h.ctx.model = undefined;
  assertOff(h);
});

test('provider switches update both the request gate and status without a reload', async t => {
  const { h } = await fixture(t, { raw: '{"enabled":true}' });
  h.start();
  for (const provider of ['openai-codex', 'openai', 'openai-codex', 'custom']) {
    h.ctx.model = { provider, id: 'previously-unknown-model' };
    await h.command('status');
    if (provider === 'openai-codex') {
      assertOn(h);
      assert.match(last(h).message, /priority requested for the current model/);
      assert.match(last(h).message, /no model restrictions/);
    } else {
      assertOff(h);
      assert.match(last(h).message, /current provider is not openai-codex/);
    }
    assert.match(last(h).message, /Server acceptance is not guaranteed/);
  }
  h.ctx.model = { provider: 'openai-codex', id: 'previously-unknown-model' };
  await h.command('off');
  assertOff(h);
});

test('priority is an immutable payload replacement, preserving all other fields', async t => {
  const { extension, h } = await fixture(t, { raw: '{"enabled":true}' });
  h.start();
  const input = Object.freeze([{ role: 'user', content: 'example' }]);
  const payload = Object.freeze({ input, service_tier: 'auto', temperature: 0, metadata: { key: 'value' } });
  for (const replacement of [extension.applyCodexFastTier(payload), h.request(payload)]) {
    assert.notEqual(replacement, payload);
    assert.deepEqual(replacement, { ...payload, service_tier: 'priority' });
    assert.equal(replacement.input, input);
    assert.equal(replacement.metadata, payload.metadata);
  }
  assert.equal(payload.service_tier, 'auto');
  const alreadyPriority = Object.freeze({ service_tier: 'priority' });
  assert.notEqual(h.request(alreadyPriority), alreadyPriority);
  assert.deepEqual(h.request(alreadyPriority), alreadyPriority);
});

test('non-object and array payloads are safe and passed through unchanged', async t => {
  const { extension, h } = await fixture(t, { raw: '{"enabled":true}' });
  h.start();
  for (const payload of [undefined, null, false, true, 0, 42, '', 'text', 1n, Symbol('x'), () => {}, Object.freeze([])]) {
    assert.equal(extension.applyCodexFastTier(payload), payload);
    assert.equal(h.request(payload), payload);
  }
});

test('factory is side-effect free, starts off, and registers only command and lifecycle/request hooks', async t => {
  const { agentDir, h } = await fixture(t);
  assert.deepEqual([...h.handlers.keys()], ['session_start', 'model_select', 'session_shutdown', 'before_provider_request']);
  assert.deepEqual([...h.commands.keys()], ['fast']);
  assertOff(h);
  assert.equal(existsSync(agentDir), false);
  h.start();
  assertOff(h);
  assert.equal(existsSync(agentDir), false);
  assert.deepEqual(h.notices, []);
  await h.command('');
  assert.match(last(h).message, /Codex Fast: off/);
  assert.equal(existsSync(agentDir), false);
});

test('disabled mode leaves even an existing priority tier untouched', async t => {
  const { h } = await fixture(t, { raw: '{"enabled":false}' });
  h.start();
  const payload = Object.freeze({ service_tier: 'priority' });
  assert.equal(h.request(payload), undefined);
  assert.equal(payload.service_tier, 'priority');
});

test('malformed JSON and invalid enabled types warn and fail closed without rewriting config', async t => {
  const { h, put, path } = await fixture(t);
  const invalid = ['', '{', 'null', 'true', 'false', '1', '"true"', '[]', '[{"enabled":true}]', '{}',
    '{"enabled":"true"}', '{"enabled":"false"}', '{"enabled":1}', '{"enabled":0}',
    '{"enabled":null}', '{"enabled":[]}', '{"enabled":{}}', '{"codexFastMode":true}'];
  for (const raw of invalid) {
    put('{"enabled":true}');
    h.start();
    assertOn(h);
    h.notices.length = 0;
    put(raw);
    h.start();
    assertOff(h);
    assert.equal(last(h).level, 'warning', raw);
    assert.ok(last(h).message.includes(path));
    assert.match(last(h).message, /defaults to off/);
    assert.equal(readFileSync(path, 'utf8'), raw);
  }
});

test('unreadable config warns and disables previously enabled runtime state', async t => {
  const { h, path } = await fixture(t, { raw: '{"enabled":true}' });
  h.start();
  assertOn(h);
  rmSync(path);
  mkdirSync(path); // Deterministic read error even when tests run as root.
  h.start();
  assertOff(h);
  assert.equal(last(h).level, 'warning');
});

test('on/off persist only the dedicated config with atomic replacement and a credit warning', async t => {
  const { h, agentDir, path } = await fixture(t);
  h.start();
  await h.command(' ON ');
  assertOn(h);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: true });
  assert.equal(last(h).level, 'warning');
  assert.match(last(h).message, /Higher credit usage/);
  assert.match(last(h).message, /priority requested/);
  assert.match(last(h).message, /not guaranteed/);
  const oldDescriptor = openSync(path, 'r');
  try {
    await h.command('off');
    assertOff(h);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: false });
    // An already-open descriptor still sees the old inode: no in-place truncation.
    assert.deepEqual(JSON.parse(readFileSync(oldDescriptor, 'utf8')), { enabled: true });
  } finally { closeSync(oldDescriptor); }
  assert.equal(last(h).level, 'info');
  assert.deepEqual(readdirSync(agentDir), ['codex-fast.json']);
});

test('explicit commands repair malformed config and persist even when state is unchanged', async t => {
  const { h, put, path } = await fixture(t, { raw: '{"enabled":"true"}' });
  h.start();
  await h.command('off');
  assertOff(h);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: false });
  h.ctx.model = { provider: 'openai', id: 'gpt-5.4' };
  await h.command('on');
  assertOff(h); // Enabled setting still does not apply to an unsupported provider.
  assert.equal(last(h).level, 'warning');
  h.ctx.model = supportedModel;
  assertOn(h);
  put('{"enabled":false}');
  await h.command('on');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: true });
  await h.command('off');
  await h.command('status');
  assert.match(last(h).message, /Codex Fast: off/);
  assert.match(last(h).message, /current provider is openai-codex; no model restrictions/);
});

test('new runtime and session_start reload persisted state; missing config resets to off', async t => {
  const { h, harness, put, path } = await fixture(t);
  await h.command('on');
  const reloaded = harness();
  assertOff(reloaded);
  reloaded.start();
  assertOn(reloaded);
  put('{"enabled":false}');
  assertOn(reloaded); // No watcher; changes take effect at session_start/reload.
  reloaded.start();
  assertOff(reloaded);
  put('{"enabled":true}');
  reloaded.start();
  assertOn(reloaded);
  rmSync(path);
  reloaded.start();
  assertOff(reloaded);
  assert.deepEqual(reloaded.notices, []);
});

test('failed atomic rename reports an error, cleans temporary files, and retains running state', async t => {
  const { h, put, path, agentDir } = await fixture(t);
  for (const enabled of [false, true]) {
    rmSync(path, { recursive: true, force: true });
    put(JSON.stringify({ enabled }));
    h.start();
    rmSync(path);
    mkdirSync(path);
    writeFileSync(join(path, 'sentinel'), 'must survive');
    h.notices.length = 0;
    await h.command(enabled ? 'off' : 'on');
    if (enabled) assertOn(h); else assertOff(h);
    assert.equal(h.notices.length, 1);
    assert.equal(last(h).level, 'error');
    assert.ok(last(h).message.includes(path));
    assert.equal(h.statuses.get('codex-fast'), enabled ? 'fast' : undefined);
    assert.match(last(h).message, new RegExp(`remains ${enabled ? 'on' : 'off'}`));
    assert.deepEqual(readdirSync(agentDir), ['codex-fast.json']);
    assert.equal(readFileSync(join(path, 'sentinel'), 'utf8'), 'must survive');
  }
});

test('failure creating the agent directory does not enable priority', async t => {
  const { h, agentDir } = await fixture(t);
  writeFileSync(agentDir, 'not a directory');
  await h.command('on');
  assertOff(h);
  assert.equal(last(h).level, 'error');
  assert.equal(readFileSync(agentDir, 'utf8'), 'not a directory');
});

test('status, empty args and invalid commands never write; status reflects the current model', async t => {
  const { h, path } = await fixture(t, { raw: '{"enabled":true}' });
  h.start();
  for (const args of ['', '  ', ' STATUS ']) {
    await h.command(args);
    assert.match(last(h).message, /Codex Fast: on/);
    assert.match(last(h).message, /priority requested for the current model/);
    assert.match(last(h).message, /Server acceptance is not guaranteed/);
    assert.equal(last(h).level, 'info');
  }
  h.ctx.model = { provider: 'openai', id: 'gpt-5.6' };
  await h.command('status');
  assert.match(last(h).message, /current provider is not openai-codex; no priority requested/);
  assertOff(h);
  h.ctx.model = undefined;
  await h.command('status');
  assert.match(last(h).message, /current provider is not openai-codex/);
  for (const args of ['toggle', 'on off', 'status extra', 'true']) {
    await h.command(args);
    assert.equal(last(h).level, 'warning');
    assert.match(last(h).message, /Usage: \/fast on/);
  }
  assert.equal(readFileSync(path, 'utf8'), '{"enabled":true}');
  h.ctx.model = supportedModel;
  assertOn(h);
});

test('argument completions support case/whitespace normalization and unmatched prefixes', async t => {
  const { h } = await fixture(t);
  const items = values => values.map(value => ({ value, label: value }));
  assert.deepEqual(h.complete(''), items(['on', 'off', 'status']));
  assert.deepEqual(h.complete(' O '), items(['on', 'off']));
  assert.deepEqual(h.complete('on'), items(['on']));
  assert.deepEqual(h.complete('of'), items(['off']));
  assert.deepEqual(h.complete('st'), items(['status']));
  assert.equal(h.complete('no'), null);
  assert.equal(h.complete('on off'), null);
});

test('no old UI migration, dependency, or config write occurs', async t => {
  const { h, agentDir, path } = await fixture(t);
  mkdirSync(agentDir);
  const legacyPath = join(agentDir, 'open-tui.json');
  const legacy = '{"enabled":true,"codexFastMode":true}';
  writeFileSync(legacyPath, legacy);
  h.start();
  assertOff(h);
  assert.equal(existsSync(path), false);
  await h.command('on');
  assert.equal(readFileSync(legacyPath, 'utf8'), legacy);
  assert.deepEqual(readdirSync(agentDir).sort(), ['codex-fast.json', 'open-tui.json']);
});

test('Fast status follows commands, provider switches, invalid reloads and shutdown', async t => {
  const { h, put } = await fixture(t, { raw: '{"enabled":true}' });
  h.start();
  assert.equal(h.statuses.get('codex-fast'), 'fast');
  h.ctx.model = { provider: 'openai', id: 'any-model' };
  h.handlers.get('model_select')({}, h.ctx);
  assert.equal(h.statuses.has('codex-fast'), false);
  h.ctx.model = { provider: 'openai-codex', id: 'any-future-model' };
  h.handlers.get('model_select')({}, h.ctx);
  assert.equal(h.statuses.get('codex-fast'), 'fast');
  await h.command('off');
  assert.equal(h.statuses.has('codex-fast'), false);
  await h.command('on');
  assert.equal(h.statuses.get('codex-fast'), 'fast');
  put('{');
  h.start();
  assert.equal(h.statuses.has('codex-fast'), false);
  await h.command('on');
  h.handlers.get('session_shutdown')({}, h.ctx);
  assert.equal(h.statuses.has('codex-fast'), false);
});

test('Fast and local footer integrate in either startup order with live updates', async t => {
  const footer = await createJiti(import.meta.url).import('../extensions/local-footer.ts');
  for (const fastFirst of [true, false]) {
    const { h, root, path } = await fixture(t, { raw: '{"enabled":true}' });
    h.ctx.cwd = root;
    h.ctx.model = { provider: 'openai-codex', id: 'future-model', reasoning: true, contextWindow: 1000000 };
    h.ctx.getContextUsage = () => ({ tokens: 100000, contextWindow: 1000000 });
    let component, renders = 0;
    const footerHandlers = new Map();
    const setStatus = h.ctx.ui.setStatus;
    h.ctx.ui.setStatus = (key, text) => { setStatus(key, text); renders++; };
    h.ctx.ui.setFooter = factory => {
      component?.dispose();
      component = factory({ requestRender: () => renders++ }, {
        fg: (_color, text) => text, getThinkingBorderColor: () => text => text,
      }, { onBranchChange: () => () => {}, getExtensionStatuses: () => h.statuses });
    };
    footer.default({ on: (name, handler) => footerHandlers.set(name, handler), getThinkingLevel: () => 'high' });
    const fire = name => {
      for (const handlers of fastFirst ? [h.handlers, footerHandlers] : [footerHandlers, h.handlers]) {
        handlers.get(name)?.({}, h.ctx);
      }
    };
    t.after(() => fire('session_shutdown'));
    const text = () => component.render(160).join('\n');
    fire('session_start');
    assert.match(text(), /high · fast · █/);
    let previousRenders = renders;
    await h.command('off');
    assert.doesNotMatch(text(), / · fast · /);
    assert.ok(renders > previousRenders);
    previousRenders = renders;
    await h.command('on');
    assert.match(text(), /high · fast · /);
    assert.ok(renders > previousRenders);
    h.ctx.model.provider = 'custom';
    fire('model_select');
    assert.doesNotMatch(text(), / · fast · /);
    h.ctx.model.provider = 'openai-codex';
    h.ctx.model.id = 'another-future-model';
    fire('model_select');
    assert.match(text(), /high · fast · /);
    // A failed save must not pretend to disable Fast in either component.
    rmSync(path); mkdirSync(path);
    await h.command('off');
    assert.equal(last(h).level, 'error');
    assert.match(text(), /high · fast · /);
    fire('session_start'); // Invalid config fails closed and clears the marker.
    assert.doesNotMatch(text(), / · fast · /);
    fire('session_shutdown');
    assert.equal(h.statuses.has('codex-fast'), false);
  }
});

test('hook works without a TUI; warnings/errors/status use stderr when no UI exists', async t => {
  const messages = [];
  t.mock.method(console, 'error', message => messages.push(message));
  for (const mode of ['print', 'json', 'rpc']) {
    const hasUI = mode === 'rpc';
    const { h, put, path } = await fixture(t, { mode, hasUI, raw: '{"enabled":true}' });
    if (!hasUI) delete h.ctx.ui;
    h.start();
    assertOn(h);
    assert.equal(h.statuses.size, 0);
    await h.command('status');
    if (hasUI) assert.match(last(h).message, /priority requested/);
    else assert.match(messages.at(-1), /priority requested/);
    put('{"enabled":"true"}');
    h.start();
    assertOff(h);
    if (hasUI) assert.equal(last(h).level, 'warning');
    else assert.match(messages.at(-1), /warning:.*defaults to off/);
    rmSync(path);
    mkdirSync(path);
    await h.command('on');
    assertOff(h);
    if (hasUI) assert.equal(last(h).level, 'error');
    else assert.match(messages.at(-1), /error:.*Cannot save/);
  }
});

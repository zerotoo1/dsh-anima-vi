#!/usr/bin/env node
/**
 * dsh-voice-v browser-half tests.
 *
 * The browser half (`lib/client.js`) is a lazy-CJS bundle that renders its
 * settings card into a third-party host UI (the DeepSeek Harness Studio). Until
 * now it had no automated tests at all: every registration defect was found by
 * a human staring at the GUI, and every fix cost about two hours.
 *
 * This suite is the harness that turns those defects into red tests. It loads
 * the shipped bundle the way the shell loads it (through
 * `window.__ModuleLoader__`, inside a `node:vm` sandbox), and it runs the
 * plugin's `apply` against a REAL cordis context, a REAL `SlotCore` registry,
 * and a `slots` service that mirrors the renderer's `slots.inject(key, cb)`
 * semantics exactly — the declaration wait, the effect ownership, and the
 * collapse on teardown.
 *
 * The host topology is the studio's own: the layout declares `sidebar` and
 * `main`, the settings shell declares `settings.section`, the Plugins section
 * declares `settings.plugins.tab`, and the Plugins page declares the two
 * configuration seats `plugins.bundle.config` and `plugins.row.config`. Only
 * when a parent entry is registered does a child slot exist, and disposing the
 * parent releases the children — the behaviour the card depends on.
 *
 * Nothing is rendered: the card component is only referenced, never mounted.
 * `test/settings.mjs` owns the rendered card; this file owns the registration.
 *
 * Run: `node test/client.mjs`.
 *
 * @module dsh-voice-v/test/client
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');

let passed = 0;
let failed = 0;

/**
 * Run one named check, containing its failure so later checks still report.
 * @param label - Test name.
 * @param body - Async body performing the assertions.
 */
async function test(label, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n       ')}`);
  }
}

/**
 * Let every pending microtask and timer callback run: cordis settles fibers
 * asynchronously, and a registration that lands one tick later is a
 * registration that landed.
 * @param ticks - How many macrotasks to wait for.
 */
async function settle(ticks = 3) {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * The identity the bundle patch documents: the row id IS the settings
 * namespace, the bundle's package name IS the bundle seat's key, and the row
 * seat's key is `bundle#rowId`. Read from the package manifest and the patch
 * file, so a rename that forgets one of the three places is caught here.
 * @returns `{ packageName, rowId, rowName }`.
 */
function readIdentity() {
  const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
  const unquote = (value) => value.replace(/^['"]|['"]$/g, '');
  const lines = patch.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  let rowId;
  let rowName;
  for (const line of lines) {
    const id = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line);
    if (id !== null && rowId === undefined) {
      rowId = unquote(id[1]);
      continue;
    }
    const name = /^\s+name:\s*(.+?)\s*$/.exec(line);
    if (name !== null && rowName === undefined) rowName = unquote(name[1]);
  }
  return { packageName: manifest.name, rowId, rowName };
}

// ---------------------------------------------------------------------------
// The studio's own packages, read from the checkout that serves the GUI.
// ---------------------------------------------------------------------------

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
const STUDIO_ROOT =
  process.env.DSH_STUDIO_ROOT ?? join(HOME, 'AppData', 'Local', 'dsh-studio', 'harness');
const CORDIS_ENTRY = join(STUDIO_ROOT, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
const SLOTS_ENTRY = join(
  STUDIO_ROOT,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-slots',
  'lib',
  'index.js',
);

if (!existsSync(CORDIS_ENTRY) || !existsSync(SLOTS_ENTRY)) {
  console.error(`dsh-voice-v client tests: the studio checkout is not at ${STUDIO_ROOT}`);
  console.error('set DSH_STUDIO_ROOT to the checkout that holds node_modules/@deepseek-ai');
  process.exit(1);
}

const { Context, Service } = await import(pathToFileURL(CORDIS_ENTRY).href);
const { SlotCore } = await import(pathToFileURL(SLOTS_ENTRY).href);

// ---------------------------------------------------------------------------
console.log('dsh-voice-v client tests\n');
console.log('the bundle');

// ---------------------------------------------------------------------------
/**
 * A minimal React namespace: enough to LOAD the bundle and to let a component
 * function be referenced. It is not a renderer — the card is never mounted
 * here, `test/settings.mjs` owns that.
 * @returns The stub React namespace.
 */
function createReactStub() {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props ?? {});
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged, key: merged.key === undefined ? null : merged.key };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(fn) {
      return fn();
    },
    useRef(initial) {
      return { current: initial };
    },
    useCallback(fn) {
      return fn;
    },
    memo(component) {
      return component;
    },
    forwardRef(render) {
      return render;
    },
  };
}

/**
 * A document stub: the bundle injects its stylesheet at load time, and this
 * is where that tag lands.
 * @returns The fake document and the tags appended to it.
 */
function createDocumentStub() {
  const appended = [];
  return {
    appended,
    querySelector() {
      return null;
    },
    createElement(tagName) {
      return { tagName, dataset: {}, textContent: '', setAttribute() {}, appendChild() {} };
    },
    head: {
      appendChild(node) {
        appended.push(node);
        return node;
      },
    },
    body: {
      appendChild(node) {
        appended.push(node);
        return node;
      },
    },
  };
}

/**
 * Load the shipped browser half the way the shell loads it: the bundle hands
 * itself to `window.__ModuleLoader__.load`, and the loader calls the factory
 * with its `require`.
 * @returns `{ exports, registrations, document }`: the module's exports, the
 *   registrations the bundle handed over, and the document stub.
 */
function loadBundle() {
  const source = readFileSync(clientPath, 'utf8');
  const registrations = [];
  const fakeDocument = createDocumentStub();
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    console,
    document: fakeDocument,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    fetch: async () => {
      throw new Error('the client test must not reach the network');
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: clientPath });
  assert.equal(registrations.length, 1, 'the bundle must hand over exactly one module');
  assert.equal(registrations[0].id, 'dsh-voice-v', 'the module id is the package name');
  const moduleExports = registrations[0].factory((specifier) => {
    if (specifier === 'react') return createReactStub();
    throw new Error(`unexpected require(${specifier})`);
  });
  return { exports: moduleExports, registrations, document: fakeDocument };
}

const bundle = loadBundle();

await test('the bundle loads through the shell module loader and exports its contract', () => {
  assert.equal(typeof bundle.exports.apply, 'function', 'the bundle must export apply');
  assert.ok(Array.isArray(bundle.exports.inject), 'the bundle must declare its requirements');
});

await test('the only top-level requirement is the slot registry', () => {
  // The service posture the bundle documents: `slots` alone. A second
  // top-level requirement would suspend the whole client entry on a host that
  // does not provide it, and the speaker button would go down over a
  // settings-only dependency.
  assert.deepEqual([...bundle.exports.inject], ['slots']);
});

await test('the bundle injects its stylesheet into the document at load time', () => {
  assert.equal(bundle.document.appended.length, 1, 'the stylesheet tag must be appended once');
  assert.equal(bundle.document.appended[0].tagName, 'style');
});

// ---------------------------------------------------------------------------
// The slot registry: the real `SlotCore`, behind a service that mirrors the
// renderer's `slots.inject(key, cb)`.
// ---------------------------------------------------------------------------

/**
 * The `slots` service the renderer installs: a cordis service over the pure
 * `SlotCore`, whose `inject(key, callback)` waits for the slot's declaration,
 * runs the callback inside the CALLER's fiber, and disposes the contribution
 * when the declaration collapses.
 *
 * This is a faithful copy of `dsh-client-ui-renderer`'s `SlotRegistry.inject`,
 * with the renderer's private members spelled out. The renderer itself is not
 * importable here (it is a browser bundle that pulls React and the whole UI
 * tree), so the semantics are mirrored against the same `SlotCore`.
 */
class SlotsService extends Service {
  constructor(ctx) {
    super(ctx, 'slots');
    this.core = new SlotCore();
  }

  /**
   * Install an effect for each declaration lifetime of a slot.
   * @param key - The slot key to depend on.
   * @param callback - Creates one disposer or an iterable of disposers.
   * @returns The disposer ending the wait and any active contribution.
   */
  inject(key, callback) {
    const ctx = this.ctx;
    const core = this.core;
    const disposeController = ctx.effect(() => {
      let active;
      let activeEpoch;
      let stopped = false;
      let unsubscribe = () => {};
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        const dispose = active;
        active = undefined;
        activeEpoch = undefined;
        dispose?.();
      };
      const reconcile = () => {
        if (stopped) return;
        const spec = core.specDynamic(key);
        const epoch = core.declarationEpoch(key);
        if (active !== undefined && activeEpoch === epoch) return;
        const dispose = active;
        active = undefined;
        activeEpoch = undefined;
        dispose?.();
        if (spec === undefined) return;
        const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`);
        active = () => {
          disposeEffect();
        };
        activeEpoch = epoch;
      };
      const changed = () => {
        try {
          reconcile();
        } catch (error) {
          if (error?.code === 'INACTIVE_EFFECT') {
            stop();
            return;
          }
          stop();
          const failure = error instanceof Error ? error : new Error(String(error));
          queueMicrotask(() => {
            throw failure;
          });
        }
      };
      unsubscribe = core.subscribeDeclaration(key, changed);
      try {
        reconcile();
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    }, `slots.inject(${JSON.stringify(key)})`);
    return () => {
      disposeController();
    };
  }

  /**
   * Register one entry into a declared slot.
   * @param options - The slot options (`name`, `key`, `id`, `children`, ...).
   * @param component - The component the slot renders.
   * @returns The disposer removing the entry.
   */
  register(options, component) {
    return this.core.register(options, component);
  }

  /**
   * Register one reusable factory definition.
   * @param options - The factory options.
   * @param component - The component the factory renders.
   * @returns The disposer removing the definition.
   */
  registerFactory(options, component) {
    return this.core.registerFactory(options, component);
  }

  /**
   * @param key - The slot key.
   * @returns The entries registered under the key.
   */
  entries(key) {
    return this.core.entries(key);
  }

  /**
   * @param key - The slot key.
   * @returns The declaration epoch of the key.
   */
  declarationEpoch(key) {
    return this.core.declarationEpoch(key);
  }

  /**
   * @param key - The slot key.
   * @returns The declared spec of the key, or undefined while undeclared.
   */
  spec(key) {
    return this.core.specDynamic(key);
  }
}

/** A component stand-in: the host's own components are not under test here. */
const HostComponent = () => null;

/**
 * The studio's own declaration topology, in the order the studio declares it.
 *
 *  * the layout registers `root` and declares `sidebar` and `main`;
 *  * the sidebar registers `sidebar` and declares `sidebar.settings`;
 *  * the settings shell registers `sidebar.settings` and declares
 *    `settings.section`;
 *  * the Plugins settings section registers `settings.section` (id
 *    `plugins`) and declares the tab list `settings.plugins.tab`;
 *  * the Plugins page registers `main` (key `plugins`) and declares the two
 *    configuration seats `plugins.bundle.config` and `plugins.row.config`;
 *  * the chat registers the conversation factory and the turn-tail node, which
 *    declares the assistant action strip.
 *
 * @param slots - The slot service.
 * @returns The disposers of every host entry, keyed by a readable name.
 */
function declareStudioTopology(slots) {
  const disposers = new Map();
  const register = (name, options, component = HostComponent) => {
    disposers.set(name, slots.register(options, component));
  };

  register('root', {
    name: 'root',
    locale: 'common',
    children: {
      sidebar: { kind: 'single', scope: 'root' },
      main: { kind: 'keyed', scope: 'root' },
    },
  });

  register('sidebar', {
    name: 'sidebar',
    locale: 'sidebar',
    children: {
      'sidebar.settings': { kind: 'single', scope: 'root' },
    },
  });

  register('sidebar.settings', {
    name: 'sidebar.settings',
    locale: 'settings',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
    },
  });

  register('settings.section:plugins', {
    name: 'settings.section',
    id: 'plugins',
    order: 15,
    label: 'Плагины',
    locale: 'settings.plugins',
    children: {
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
    },
  });

  register('main:plugins', {
    name: 'main',
    key: 'plugins',
    locale: 'pluginManager',
    children: {
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      'plugins.row.config': { kind: 'keyed', scope: 'root' },
    },
  });

  disposers.set(
    'factory:conversation.content',
    slots.registerFactory(
      {
        name: 'conversation.content',
        scope: 'session-maybe',
        children: {
          'conversation.session': { kind: 'single', scope: 'session' },
        },
      },
      HostComponent,
    ),
  );

  register('conversation.session', {
    name: 'conversation.session',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
    },
  });

  register('conversation.view:chat', {
    name: 'conversation.view',
    id: 'chat',
    order: 0,
    label: 'Чат',
    children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  });

  register('conversation.chat.node:turn-tail', {
    name: 'conversation.chat.node',
    key: 'turn-tail',
    children: {
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    },
  });

  return disposers;
}

/**
 * The shared form the studio hands the card: the face of the studio's own
 * `ConfigFormController` (`getSnapshot`, `subscribe`, `set`, `unset`,
 * `mutate`, `dispose`).
 * @param namespace - The settings namespace the form belongs to.
 * @returns The form and the writes it received.
 */
function createSharedForm(namespace) {
  const snapshot = {
    status: 'ready',
    value: {},
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  };
  const listeners = new Set();
  const writes = [];
  return {
    namespace,
    writes,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: async (field, value) => {
      writes.push({ op: 'set', field, value });
      return true;
    },
    unset: async (field) => {
      writes.push({ op: 'unset', field });
      return true;
    },
    mutate: async (ops) => {
      writes.push(...ops);
      return true;
    },
    dispose: async () => {
      listeners.clear();
    },
  };
}

/**
 * The studio's `configForms` service: `get(entryId)` always answers a
 * controller, never undefined. `whileServed` is the studio's own — a
 * registration that lives while the Host serves one of the namespaces and is
 * withdrawn when it stops serving them
 * (`dsh-client-ui-settings/lib/client.js`, the studio's `ConfigForms`).
 * @param shared - The form the service hands out for the namespace.
 * @param options - `served: false` starts with the Host serving nothing.
 * @returns The service, the namespaces it was asked for, and the served set.
 */
function createConfigForms(shared, options = {}) {
  const requested = [];
  const served = new Set(options.served === false ? [] : [shared.namespace]);
  const listeners = new Set();
  return {
    requested,
    served,
    get(entryId) {
      requested.push(entryId);
      return shared;
    },
    describe: () => ({ namespaces: [...served].map((ns) => ({ ns })) }),
    whileServed(namespaces, register) {
      let off;
      const sync = () => {
        const watched = namespaces.some((namespace) => served.has(namespace));
        if (watched && off === undefined) off = register(new Set(served));
        else if (!watched && off !== undefined) {
          off();
          off = undefined;
        }
      };
      const unsubscribe = () => {
        for (const listener of [...listeners]) listener();
      };
      listeners.add(sync);
      sync();
      return () => {
        unsubscribe();
        off?.();
        off = undefined;
      };
    },
    serve(namespace) {
      served.add(namespace);
      for (const listener of [...listeners]) listener();
    },
    unserve(namespace) {
      served.delete(namespace);
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * Build one studio session: a real cordis context, the real slot registry, the
 * studio's services, and the studio's declaration topology.
 * @param options - `configForms`: false to withhold the form service;
 *   `settingsScope`: the scope binder of the imperative host.
 * @returns The session.
 */
function createStudioSession(options = {}) {
  const ctx = new Context();
  const errors = [];
  ctx.logger.exporter({
    levels: { default: 0 },
    export: (message) => {
      if (message.type === 'error') errors.push(message);
    },
  });
  const slots = new SlotsService(ctx);
  const shared = createSharedForm('dsh-voice-v');
  const configForms = createConfigForms(shared, { served: options.served });
  if (options.configForms !== false) ctx.provide('configForms', configForms);
  if (options.settingsScope !== undefined) ctx.provide('settingsScope', options.settingsScope);
  const topology = options.topology === undefined ? declareStudioTopology(slots) : options.topology;
  return { ctx, slots, core: slots.core, shared, configForms, errors, topology };
}

/**
 * Mount the browser half into a session, the way the shell's client runner
 * does: the bundle's own `inject` list becomes the fiber's requirements.
 * @param session - The session to mount into.
 * @returns The fiber of the mounted plugin.
 */
async function mountPlugin(session) {
  const fiber = session.ctx.plugin({ inject: bundle.exports.inject, apply: bundle.exports.apply });
  await fiber;
  await settle();
  return fiber;
}

/**
 * @param core - The slot registry.
 * @param key - The slot key.
 * @param cell - The `key` or `id` the entry carries.
 * @returns The entry, or undefined.
 */
function findEntry(core, key, cell) {
  return core.entries(key).find((entry) => entry.options.key === cell || entry.options.id === cell);
}

// ---------------------------------------------------------------------------
console.log('\nthe studio host (a real cordis context, a real slot registry)');

const studio = createStudioSession();
await mountPlugin(studio);

await test("the plugin's own page seat holds the bundle under its package name", () => {
  const entry = findEntry(studio.core, 'plugins.bundle.config', 'dsh-voice-v');
  assert.ok(entry !== undefined, 'the bundle seat must hold an entry');
  assert.equal(entry.options.key, 'dsh-voice-v');
  // A keyed seat takes a key and no id: the registry rejects the other shape.
  assert.equal(entry.options.id, undefined, 'a keyed seat carries no id');
});

await test("the plugin's own row seat holds the bundle under bundle#rowId", () => {
  const entry = findEntry(studio.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v');
  assert.ok(entry !== undefined, 'the row seat must hold an entry');
  assert.equal(entry.options.key, 'dsh-voice-v#dsh-voice-v');
  assert.equal(entry.options.id, undefined, 'a keyed seat carries no id');
});

await test('the settings tab list holds the bundle under its namespace', () => {
  const entry = findEntry(studio.core, 'settings.plugins.tab', 'dsh-voice-v');
  assert.ok(entry !== undefined, 'the tab list must hold an entry');
  assert.equal(entry.options.id, 'dsh-voice-v');
  // A list seat takes an id and no key.
  assert.equal(entry.options.key, undefined, 'a list seat carries no key');
});

await test('the tab carries the order and the label the settings page reads', () => {
  const entry = findEntry(studio.core, 'settings.plugins.tab', 'dsh-voice-v');
  assert.equal(entry.options.order, 10);
  assert.equal(entry.options.label, 'Голос');
});

await test('the injected scope is the shared form of the namespace', () => {
  const entry = findEntry(studio.core, 'plugins.bundle.config', 'dsh-voice-v');
  assert.equal(typeof entry.inject, 'function', 'the entry must carry an inject factory');
  const injected = entry.inject();
  assert.ok(injected !== null && typeof injected === 'object', 'the injected scope must be an object');
  assert.equal(injected.scope, studio.shared, 'the scope must be the shared form');
  // The card calls exactly this face of the scope.
  for (const method of ['getSnapshot', 'subscribe', 'set', 'unset']) {
    assert.equal(typeof injected.scope[method], 'function', `the scope must expose ${method}`);
  }
});

await test('all three seats share one form of one namespace', () => {
  const bundle = findEntry(studio.core, 'plugins.bundle.config', 'dsh-voice-v');
  const row = findEntry(studio.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v');
  const tab = findEntry(studio.core, 'settings.plugins.tab', 'dsh-voice-v');
  assert.equal(bundle.inject().scope, studio.shared);
  assert.equal(row.inject().scope, studio.shared);
  assert.equal(tab.inject().scope, studio.shared);
  assert.deepEqual(studio.configForms.requested, ['dsh-voice-v'], 'the form service is asked once, by namespace');
});

await test('the speaker button keeps its seat in the assistant action strip', () => {
  const entry = findEntry(studio.core, 'conversation.chat.assistant-actions', 'voice-v');
  assert.ok(entry !== undefined, 'the speaker button must register');
  assert.equal(entry.options.id, 'voice-v');
  assert.equal(entry.options.order, 20);
});

await test('the whole session logged no error', () => {
  const reported = studio.errors.map((message) => String(message.args?.[0]?.stack ?? message.args?.[0]));
  assert.deepEqual(reported, [], `the browser half logged errors: ${reported.join(' | ')}`);
});

await test('the seat keys follow the row identity the patch documents', () => {
  // The patch file states the contract: the row id IS the settings namespace,
  // the Loader entry id and the card's form key are one string, and the row
  // seat is addressed by `bundle#rowId`.
  const identity = readIdentity();
  assert.equal(identity.packageName, 'dsh-voice-v', 'the package name is the bundle name');
  assert.equal(identity.rowId, identity.packageName, 'the row id is the package name');
  assert.equal(identity.rowName, identity.packageName, 'the Loader entry id is the package name');

  const bundle = findEntry(studio.core, 'plugins.bundle.config', identity.packageName);
  assert.ok(bundle !== undefined, 'the bundle seat must be keyed by the package name');
  assert.equal(bundle.options.key, identity.packageName);

  const row = findEntry(studio.core, 'plugins.row.config', `${identity.packageName}#${identity.rowId}`);
  assert.ok(row !== undefined, 'the row seat must be keyed by bundle#rowId');
  assert.equal(row.options.key, `${identity.packageName}#${identity.rowId}`);

  const tab = findEntry(studio.core, 'settings.plugins.tab', identity.rowId);
  assert.ok(tab !== undefined, 'the tab must carry the row id');
  assert.equal(tab.options.id, identity.rowId);

  assert.deepEqual(
    studio.configForms.requested,
    [identity.rowId],
    'the form service must be asked for the row id, and for nothing else',
  );
});

// ---------------------------------------------------------------------------
console.log('\nthe host tears the page down');

await test('disposing the page seat takes the card with it', async () => {
  const session = createStudioSession();
  await mountPlugin(session);
  assert.ok(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v') !== undefined,
    'the card must be there before the teardown',
  );

  // The Plugins page tears its own entry down: the child seats collapse, and
  // the browser half's contribution must go with them.
  const epochBefore = session.core.declarationEpoch('plugins.bundle.config');
  session.topology.get('main:plugins')();
  await settle();

  assert.equal(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v'),
    undefined,
    'the card must not survive the teardown of the seat that declared it',
  );
  assert.equal(
    findEntry(session.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v'),
    undefined,
    'the row seat must not survive the teardown either',
  );
  assert.equal(
    session.core.spec('plugins.bundle.config'),
    undefined,
    'the child seat must collapse with its parent',
  );
  assert.ok(
    session.core.declarationEpoch('plugins.bundle.config') > epochBefore,
    'the declaration epoch must advance on the collapse',
  );
});

await test('the settings tab survives the teardown of the page', async () => {
  const session = createStudioSession();
  await mountPlugin(session);
  session.topology.get('main:plugins')();
  await settle();

  assert.ok(
    findEntry(session.core, 'settings.plugins.tab', 'dsh-voice-v') !== undefined,
    'the tab belongs to another parent and must stay',
  );
  assert.ok(
    findEntry(session.core, 'conversation.chat.assistant-actions', 'voice-v') !== undefined,
    'the speaker button belongs to another parent and must stay',
  );
});

// ---------------------------------------------------------------------------
console.log('\nthe load order');

await test('a bundle that mounts before the page still lands when the page declares its seats', async () => {
  // The plugin may mount before the Plugins page does. Its registration must
  // WAIT for the declaration instead of throwing away the card.
  const ctx = new Context();
  const errors = [];
  ctx.logger.exporter({
    levels: { default: 0 },
    export: (message) => {
      if (message.type === 'error') errors.push(message);
    },
  });
  const slots = new SlotsService(ctx);
  const shared = createSharedForm('dsh-voice-v');
  ctx.provide('configForms', createConfigForms(shared));

  const fiber = ctx.plugin({ inject: bundle.exports.inject, apply: bundle.exports.apply });
  await fiber;
  await settle();

  assert.equal(
    findEntry(slots.core, 'plugins.bundle.config', 'dsh-voice-v'),
    undefined,
    'nothing can be registered before the seat exists',
  );

  declareStudioTopology(slots);
  await settle();

  assert.ok(
    findEntry(slots.core, 'plugins.bundle.config', 'dsh-voice-v') !== undefined,
    'the card must land as soon as the page declares its seat',
  );
  assert.ok(
    findEntry(slots.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v') !== undefined,
    'the row seat must land too',
  );
  assert.ok(
    findEntry(slots.core, 'settings.plugins.tab', 'dsh-voice-v') !== undefined,
    'the tab must land too',
  );
  assert.deepEqual(errors, [], 'waiting for a declaration must not log an error');
});

// ---------------------------------------------------------------------------
console.log('\nthe service arrives late');

await test('the card lands when the form service is there from the start', async () => {
  const session = createStudioSession();
  await mountPlugin(session);
  assert.ok(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v') !== undefined,
    'the bundle seat must land',
  );
  assert.ok(
    findEntry(session.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v') !== undefined,
    'the row seat must land',
  );
  assert.ok(
    findEntry(session.core, 'settings.plugins.tab', 'dsh-voice-v') !== undefined,
    'the tab must land',
  );
});

await test('the card must land when the form service arrives after the plugin', async () => {
  // The order that must hold on every host: the plugin's apply may run
  // BEFORE the settings service is provided. The card must still land when
  // the service shows up.
  const session = createStudioSession({ configForms: false });
  await mountPlugin(session);
  assert.equal(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v'),
    undefined,
    'nothing can land before the form service exists',
  );

  session.ctx.provide('configForms', session.configForms);
  await settle();

  assert.ok(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v') !== undefined,
    'the card must land once the form service arrives — the form service is waited ' +
      'for in a fiber of its own, so a service that shows up later is seen when it shows up',
  );
  assert.ok(
    findEntry(session.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v') !== undefined,
    'the row seat must land once the form service arrives',
  );
  assert.ok(
    findEntry(session.core, 'settings.plugins.tab', 'dsh-voice-v') !== undefined,
    'the tab must land once the form service arrives',
  );
});

await test('the card must land when the Host starts serving the namespace later', async () => {
  // The second late arrival: the service exists, but the Host's settings
  // document — the mirror that names the namespaces — has not arrived yet.
  // The card is registered through `whileServed`, so it lands with the
  // namespace, not with the service.
  const session = createStudioSession({ served: false });
  await mountPlugin(session);
  assert.equal(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v'),
    undefined,
    'nothing may land while the Host serves no namespace',
  );

  session.configForms.serve('dsh-voice-v');
  await settle();

  assert.ok(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v') !== undefined,
    'the card must land when the Host starts serving the namespace',
  );
  assert.ok(
    findEntry(session.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v') !== undefined,
    'the row seat must land with the namespace',
  );
  assert.ok(
    findEntry(session.core, 'settings.plugins.tab', 'dsh-voice-v') !== undefined,
    'the tab must land with the namespace',
  );
});

await test('the card is withdrawn when the Host stops serving the namespace', async () => {
  const session = createStudioSession();
  await mountPlugin(session);
  assert.ok(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v') !== undefined,
    'the card must be there while the Host serves the namespace',
  );

  session.configForms.unserve('dsh-voice-v');
  await settle();

  assert.equal(
    findEntry(session.core, 'plugins.bundle.config', 'dsh-voice-v'),
    undefined,
    'the card must go when the Host stops serving the namespace',
  );
  assert.equal(
    findEntry(session.core, 'plugins.row.config', 'dsh-voice-v#dsh-voice-v'),
    undefined,
    'the row seat must go with it',
  );
});

// ---------------------------------------------------------------------------
console.log('\nthe imperative host (no configForms service)');

await test('without the form service the card falls back to the scope binder', async () => {
  const scope = createSharedForm('dsh-voice-v');
  const binder = {
    bind(request) {
      // The request object comes from the bundle's own realm, so its fields
      // are compared one by one: a deep comparison would fail on the
      // prototype alone.
      assert.equal(request.namespace, 'dsh-voice-v');
      return scope;
    },
  };
  // The imperative host declares one keyed seat: the Plugins settings item.
  const ctx = new Context();
  const errors = [];
  ctx.logger.exporter({
    levels: { default: 0 },
    export: (message) => {
      if (message.type === 'error') errors.push(message);
    },
  });
  const slots = new SlotsService(ctx);
  ctx.provide('settingsScope', binder);
  slots.register(
    {
      name: 'root',
      children: {
        'settings.plugin.item': { kind: 'keyed', scope: 'root' },
      },
    },
    HostComponent,
  );

  const fiber = ctx.plugin({ inject: bundle.exports.inject, apply: bundle.exports.apply });
  await fiber;
  await settle();

  const entry = findEntry(slots.core, 'settings.plugin.item', 'dsh-voice-v');
  assert.ok(entry !== undefined, 'the imperative seat must hold the card');
  assert.equal(entry.options.key, 'dsh-voice-v');
  assert.equal(entry.inject().scope, scope, 'the imperative card gets the bound scope');

  assert.equal(
    findEntry(slots.core, 'settings.plugins.tab', 'dsh-voice-v'),
    undefined,
    'the studio seats must stay empty on the imperative host',
  );
  assert.deepEqual(errors, [], `the imperative host logged errors: ${errors.length}`);
});

await test('without the form service and without the binder nothing registers and nothing throws', async () => {
  const ctx = new Context();
  const errors = [];
  ctx.logger.exporter({
    levels: { default: 0 },
    export: (message) => {
      if (message.type === 'error') errors.push(message);
    },
  });
  const slots = new SlotsService(ctx);
  slots.register(
    {
      name: 'root',
      children: {
        'settings.plugin.item': { kind: 'keyed', scope: 'root' },
      },
    },
    HostComponent,
  );

  let thrown = null;
  try {
    const fiber = ctx.plugin({ inject: bundle.exports.inject, apply: bundle.exports.apply });
    await fiber;
    await settle();
  } catch (error) {
    thrown = error;
  }

  assert.equal(thrown, null, `apply must not throw: ${String(thrown?.stack ?? thrown)}`);
  assert.deepEqual(errors, [], 'a host without either service must not log an error');
  assert.equal(findEntry(slots.core, 'settings.plugin.item', 'dsh-voice-v'), undefined);
});

// ---------------------------------------------------------------------------
console.log('');
if (failed > 0) {
  console.error(`dsh-voice-v client tests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`dsh-voice-v client tests: ${passed} passed, 0 failed`);
console.log(`client: ${passed} passed / 0 failed`);

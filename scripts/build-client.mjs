#!/usr/bin/env node
/**
 * dsh-voice-v client bundle build step.
 *
 * The browser half is authored directly in the lazy-CJS bundle protocol
 * (`window.__ModuleLoader__.load({ id, factory })`) rather than compiled into
 * it, so this script is a build *gate*, not a bundler: it compiles the bundle
 * for syntax, evaluates it against a stub loader, runs the factory and `apply`
 * against a stub client context, and asserts the contract the DSH client module
 * system, the slot registry, and the settings surface all depend on.
 *
 * It fails loudly on the mistakes that would otherwise surface as a blank
 * button or a missing settings card at runtime:
 *
 *  1. the registration id does not equal the package name, so the boot graph
 *     row can never claim the factory;
 *  2. the bundle requires a specifier that is neither a platform seed word nor
 *     declared in `dsh.client.external`, so `require` misses the module table;
 *  3. the factory does not export `apply` / `inject`, so the client half never
 *     mounts;
 *  4. the speaker action or the settings card is not registered, is registered
 *     under the wrong slot name, or the card is filed into the Official group's
 *     `plugins.item` list instead of this bundle's own page seats — the
 *     `plugins.bundle.config` section keyed by the package name and the
 *     `plugins.row.config` section keyed by `bundle#rowId`;
 *  5. the settings card is mounted outside `configForms.whileServed` (so it
 *     could outlive a Host that never serves the namespace), is not bound to
 *     `configForms.get(SETTINGS_NAMESPACE)`, or the whole client entry declares
 *     `configForms` at top level — which would suspend the speaker button on a
 *     host that does not provide it.
 *
 * Usage:
 *   node scripts/build-client.mjs            # verify and report
 *   node scripts/build-client.mjs --check    # identical; provided for `npm run verify`
 *
 * @module dsh-voice-v/scripts/build-client
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { SETTINGS_NAMESPACE } from '../lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const manifestPath = join(packageRoot, 'package.json');
const clientPath = join(packageRoot, 'lib', 'client.js');

/**
 * Module specifiers the DSH web shell seeds into the client module table
 * unconditionally — the literal `staticModules` table in
 * `@deepseek-ai/dsh-web-frontend`'s shell bundle. A bundle may require these
 * with no `dsh.client.external` declaration.
 */
const PLATFORM_SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]);

/** Slot the speaker button registers into. */
const ACTION_SLOT = 'conversation.chat.assistant-actions';

/**
 * Slot the settings card registers into on the imperative host: a KEYED slot
 * declared by the Plugins settings surface, whose key domain is the settings
 * namespace (the page dispatches `{ entryKey: ns }` for every namespace the
 * Host serves). Not `plugins.item` — that list is the Official group.
 */
const CARD_SLOT = 'settings.plugin.item';

/**
 * Slot the settings card registers into on the declarative host: a LIST slot
 * declared by the Plugins settings section, whose entries are the tabs the
 * section renders, one per namespace.
 */
const CARD_TAB_SLOT = 'settings.plugins.tab';

/** The list slot the card must NOT be filed into. */
const OFFICIAL_ITEM_SLOT = 'plugins.item';

/**
 * Services the whole browser half must wait for. Neither the settings binder
 * nor the shared form service is here: both are waited for in the card's own
 * fibers, so their absence cannot suspend the speaker button, which needs only
 * `slots`.
 */
const REQUIRED_SERVICES = ['slots'];

/** Services the settings card's nested fiber must wait for. */
const CARD_SERVICES = ['slots'];

/** Services that must never be declared in the top-level `inject`. */
const OPTIONAL_SERVICES = ['settingsScope', 'configForms'];

const failures = [];
const notes = [];

/**
 * Record one contract violation.
 * @param message - Human-readable description.
 */
function fail(message) {
  failures.push(message);
}

/**
 * Record one successful check.
 * @param message - Human-readable description.
 */
function ok(message) {
  notes.push(message);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const source = readFileSync(clientPath, 'utf8');

// 1. Syntax: compile as a classic script without executing it.
try {
  new vm.Script(source, { filename: clientPath });
  ok(`syntax: ${source.length} bytes compile cleanly`);
} catch (error) {
  fail(`syntax: ${String(error?.message ?? error)}`);
}

// 2. Manifest wiring the client module system reads.
const clientPathRel = manifest?.exports?.['./client'];
if (typeof clientPathRel !== 'string' || clientPathRel !== './lib/client.js') {
  fail(`package.json exports["./client"] must be "./lib/client.js", found ${JSON.stringify(clientPathRel)}`);
} else {
  ok('manifest: exports["./client"] -> ./lib/client.js');
}
if (manifest?.dsh?.client?.platform !== 'web') {
  fail(`package.json dsh.client.platform must be "web", found ${JSON.stringify(manifest?.dsh?.client?.platform)}`);
} else {
  ok('manifest: dsh.client.platform = web');
}

// 3. Evaluate against a stub loader to capture the registration.
const registrations = [];
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
  },
  console,
};
sandbox.globalThis = sandbox;

try {
  vm.runInNewContext(source, sandbox, { filename: clientPath });
} catch (error) {
  fail(`evaluation: registering the bundle threw: ${String(error?.message ?? error)}`);
}

if (registrations.length !== 1) {
  fail(`registration: expected exactly one __ModuleLoader__.load call, saw ${registrations.length}`);
} else {
  const registration = registrations[0];
  if (registration.id !== manifest.name) {
    fail(`registration: id ${JSON.stringify(registration.id)} must equal the package name ${JSON.stringify(manifest.name)}`);
  } else {
    ok(`registration: id = ${registration.id}`);
  }
  if (typeof registration.factory !== 'function') {
    fail('registration: factory must be a function');
  } else {
    // 4. Externals: every required specifier must resolve in the module table.
    const required = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    const declared = Array.isArray(manifest?.dsh?.client?.external) ? manifest.dsh.client.external : [];
    const unresolved = [...new Set(required)].filter(
      (specifier) =>
        !PLATFORM_SEED.has(specifier) &&
        !declared.some((entry) => entry === specifier || `${entry}/client` === specifier),
    );
    if (unresolved.length > 0) {
      fail(`externals: undeclared require specifiers ${JSON.stringify(unresolved)}`);
    } else {
      ok(`externals: ${[...new Set(required)].join(', ') || '(none)'} all resolve`);
    }

    // 5. Factory contract: `apply` and `inject` must reach the client half.
    const reactStub = {
      createElement: () => null,
      useState: () => [undefined, () => {}],
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
      useEffect: () => {},
      useMemo: (fn) => fn(),
      memo: (component) => component,
      Fragment: function Fragment() {},
    };
    const requireStub = (specifier) => {
      if (specifier === 'react') return reactStub;
      throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
    };
    let clientExports;
    try {
      clientExports = registration.factory(requireStub);
    } catch (error) {
      fail(`factory: threw before returning exports: ${String(error?.message ?? error)}`);
    }
    if (clientExports !== undefined) {
      if (typeof clientExports.apply !== 'function') fail('factory: exports.apply is not a function');
      else ok('factory: exports.apply is a function');
      if (!Array.isArray(clientExports.inject)) {
        fail('factory: exports.inject is not an array');
      } else if (clientExports.inject.some((entry) => typeof entry !== 'string')) {
        fail('factory: exports.inject must contain only strings');
      } else {
        const missing = REQUIRED_SERVICES.filter((service) => !clientExports.inject.includes(service));
        if (missing.length > 0) {
          fail(`factory: exports.inject must list ${missing.join(', ')} (saw ${JSON.stringify(clientExports.inject)})`);
        } else if (clientExports.inject.length === 0) {
          notes.push('note: exports.inject is empty; the client half registers no services');
        } else {
          ok(`factory: exports.inject = [${clientExports.inject.join(', ')}]`);
        }
        // A settings-only dependency must not be able to suspend the speaker
        // button: declaring it here would keep the whole entry from activating
        // on a host that does not provide it.
        const overDeclared = OPTIONAL_SERVICES.filter((service) => clientExports.inject.includes(service));
        if (overDeclared.length > 0) {
          fail(
            `factory: exports.inject must not declare ${overDeclared.join(', ')} at top level (the card waits for it in a nested ctx.inject)`,
          );
        } else {
          ok(`factory: exports.inject leaves ${OPTIONAL_SERVICES.join(', ')} to the card's nested fiber`);
        }
      }

      // 6. Mount against a stub client context and read back the registrations.
      if (typeof clientExports.apply === 'function') {
        /**
         * Build a stub context that records what the bundle does.
         * @param options - whether the host provides the settings binder.
         * @returns the stub context and the ledgers the checks read.
         */
        function makeCtx({ withBinder, withForms, served = true }) {
          const ledger = {
            injections: [],
            slotRegistrations: [],
            bindCalls: [],
            formCalls: [],
            whileServedCalls: [],
            effectLabels: [],
            nestedInjectServices: [],
            inEffect: false,
            inWhileServed: false,
          };
          const formStub = {
            getSnapshot: () => ({
              status: 'loading',
              value: undefined,
              base: undefined,
              user: undefined,
              revision: undefined,
              writable: false,
              mode: 'host',
            }),
            subscribe: () => () => {},
            set: async () => true,
            unset: async () => true,
            mutate: async () => true,
          };
          /** The per-fiber face: the same services, plus effect/inject tracking. */
          const fiberFace = {
            effect(callback, label) {
              ledger.effectLabels.push(label);
              const outer = ledger.inEffect;
              ledger.inEffect = true;
              let disposer;
              try {
                disposer = callback();
              } finally {
                ledger.inEffect = outer;
              }
              return () => {
                if (typeof disposer === 'function') disposer();
              };
            },
            inject(services, callback) {
              ledger.nestedInjectServices.push([...services]);
              // A strict cordis proxy throws on a read of an undeclared service,
              // and a fiber never starts until every declared one exists; a
              // missing service therefore means the callback never runs.
              const missing = services.filter((service) => !fiberFace[service]);
              if (missing.length > 0) return undefined;
              return callback(fiberFace);
            },
            slots: {
              inject(name, factory) {
                ledger.injections.push({ name, factory });
                return () => {};
              },
              register(options, component) {
                ledger.slotRegistrations.push({ options, component });
                return () => {};
              },
            },
            get(name) {
              if (name === 'settingsScope') return withBinder ? settingsScopeStub : undefined;
              if (name === 'configForms') return withForms ? configFormsStub : undefined;
              return undefined;
            },
          };
          // The studio's shared form service: one controller per namespace,
          // and `whileServed` — the registration lives while the Host serves
          // the namespace, and is withdrawn when it stops
          // (`dsh-client-ui-settings/lib/client.js`).
          const configFormsStub = {
            get(entryId) {
              ledger.formCalls.push({ entryId, inWhileServed: ledger.inWhileServed });
              return formStub;
            },
            whileServed(namespaces, register) {
              ledger.whileServedCalls.push([...namespaces]);
              if (!served) return () => {};
              ledger.inWhileServed = true;
              let off;
              try {
                off = register(new Set([SETTINGS_NAMESPACE]));
              } finally {
                ledger.inWhileServed = false;
              }
              return () => {
                off?.();
              };
            },
          };
          const settingsScopeStub = {
            bind(spec) {
              ledger.bindCalls.push({ ...spec });
              return formStub;
            },
          };
          // A cordis context answers a service by property access, and a fiber
          // that names one only starts when that service exists.
          if (withForms) fiberFace.configForms = configFormsStub;
          if (withBinder) fiberFace.settingsScope = settingsScopeStub;
          return { ctx: fiberFace, ledger, formStub };
        }

        /**
         * Mount the bundle against one shape of host and check what the card
         * registered.
         * @param options - `withForms` (the declarative host) and
         *   `withBinder` (the imperative host).
         * @param expected - `host` (which surface answered) and `slot` (the
         *   seat the card must land in).
         */
        function checkHost({ withForms, withBinder }, expected) {
          const { ctx: ctxStub, ledger, formStub } = makeCtx({ withForms, withBinder });
          const { injections, slotRegistrations, bindCalls, formCalls } = ledger;

          try {
            clientExports.apply(ctxStub);
          } catch (error) {
            fail(`apply: mounting against a stub context threw: ${String(error?.message ?? error)}`);
            return;
          }

          // The card's nested fiber must ask for `slots` itself — a nested
          // strict scope cannot read what it does not declare.
          const nested = ledger.nestedInjectServices[0];
          if (nested === undefined) {
            fail('apply: the settings card must wait for its services in a nested ctx.inject');
          } else {
            const absent = CARD_SERVICES.filter((service) => !nested.includes(service));
            if (absent.length > 0) {
              fail(`apply: the card's nested ctx.inject must list ${absent.join(', ')}, saw ${JSON.stringify(nested)}`);
            } else {
              ok(`apply: the card waits on ctx.inject([${nested.join(', ')}])`);
            }
          }

          // The form service is waited for in a fiber of its own. It comes up
          // with the Host's remote link, and a one-shot read sees nothing —
          // the studio branch is skipped and the card is lost for good.
          const waitsForForms = ledger.nestedInjectServices.some((services) => services.includes('configForms'));
          if (!waitsForForms) {
            fail(
              'apply: the card must wait for the form service in a nested ctx.inject — a service that arrives later is never seen again',
            );
          } else {
            ok('apply: the card waits for the form service in a nested ctx.inject');
          }

          // The scope is bound to the namespace, which is the Host Loader row id.
          if (expected.host === 'forms') {
            if (formCalls.length === 0 || formCalls[0].entryId !== SETTINGS_NAMESPACE) {
              fail(
                `apply: the shared form must be taken for ${JSON.stringify(SETTINGS_NAMESPACE)}, saw ${JSON.stringify(formCalls.map((call) => call.entryId))}`,
              );
            } else {
              ok(`apply: the shared form is taken for ${SETTINGS_NAMESPACE}`);
            }
            // The card is mounted while the Host serves the namespace, and
            // nowhere else: a Host that never serves it must show no trace
            // of the card.
            if (ledger.whileServedCalls.length === 0) {
              fail(
                'apply: the card must be mounted through configForms.whileServed — a Host that never serves the namespace must show no trace of the card',
              );
            } else {
              ok('apply: the card is mounted through configForms.whileServed');
            }
            if (formCalls.some((call) => call.inWhileServed !== true)) {
              fail('apply: the shared form must be taken inside whileServed, not before it');
            } else {
              ok('apply: the shared form is taken inside whileServed');
            }
          } else if (bindCalls.length === 0 || bindCalls[0].namespace !== SETTINGS_NAMESPACE) {
            fail(
              `apply: the settings scope must be bound to the namespace ${JSON.stringify(SETTINGS_NAMESPACE)}, saw ${JSON.stringify(bindCalls.map((call) => call.namespace))}`,
            );
          } else {
            ok(`apply: the settings scope is bound to ${SETTINGS_NAMESPACE}`);
          }

          // The card must never be filed into the Official group's list seat.
          if (injections.some((entry) => entry.name === OFFICIAL_ITEM_SLOT)) {
            fail(`apply: the card must not register into ${OFFICIAL_ITEM_SLOT} (that list is the Official group)`);
          } else {
            ok(`apply: the card stays out of ${OFFICIAL_ITEM_SLOT}`);
          }

          const names = injections.map((entry) => entry.name);
          for (const slot of [ACTION_SLOT, expected.slot]) {
            if (!names.includes(slot)) fail(`apply: nothing injected into ${slot}`);
            else ok(`apply: injects into ${slot}`);
          }

          // Drive each injected generator/factory so its register() call runs.
          for (const injection of injections) {
            try {
              const produced = injection.factory();
              if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
                produced.next();
                if (typeof produced.return === 'function') produced.return();
              }
            } catch (error) {
              fail(`apply: the ${injection.name} injection threw while registering: ${String(error?.message ?? error)}`);
            }
          }

          const action = slotRegistrations.find((entry) => entry?.options?.name === ACTION_SLOT);
          if (action === undefined) {
            fail(`apply: no registration carries name ${ACTION_SLOT}`);
          } else {
            if (typeof action.component !== 'function') fail(`apply: the ${ACTION_SLOT} component is not a function`);
            const actionProps = typeof action.options.inject === 'function' ? action.options.inject('session-1') : null;
            if (actionProps === null || actionProps.sessionId !== 'session-1') {
              fail(`apply: the ${ACTION_SLOT} injection must pass sessionId through to the button`);
            } else {
              ok(`apply: ${ACTION_SLOT} receives sessionId`);
            }
          }

          const card = slotRegistrations.find((entry) => entry?.options?.name === expected.slot);
          if (card === undefined) {
            fail(`apply: no registration carries name ${expected.slot}`);
          } else {
            if (expected.host === 'forms') {
              // List slot: the id IS the namespace, and the section dispatches
              // the tab by it.
              if (card.options.id !== SETTINGS_NAMESPACE) {
                fail(
                  `apply: the ${expected.slot} tab must carry the id ${JSON.stringify(SETTINGS_NAMESPACE)}, found ${JSON.stringify(card.options.id)}`,
                );
              } else {
                ok(`apply: ${expected.slot} carries the id ${SETTINGS_NAMESPACE}`);
              }
              if (typeof card.options.label !== 'string' || card.options.label === '') {
                fail(`apply: the ${expected.slot} tab must carry a label`);
              } else {
                ok(`apply: ${expected.slot} carries a label`);
              }
            } else {
              // Keyed slot: the key is the npm package name the page dispatches on.
              if (card.options.key !== SETTINGS_NAMESPACE) {
                fail(
                  `apply: the ${expected.slot} card must be keyed on the package name ${JSON.stringify(SETTINGS_NAMESPACE)}, found ${JSON.stringify(card.options.key)}`,
                );
              } else {
                ok(`apply: ${expected.slot} keyed on ${SETTINGS_NAMESPACE}`);
              }
              // List-only shape fields must not appear on a keyed registration.
              for (const stray of ['id', 'order', 'label']) {
                if (card.options[stray] !== undefined) {
                  fail(`apply: the ${expected.slot} keyed entry must not carry ${stray}, found ${JSON.stringify(card.options[stray])}`);
                }
              }
              ok(`apply: ${expected.slot} carries no id/order/label`);
            }
            if (typeof card.component !== 'function') {
              fail(`apply: the ${expected.slot} component is not a function`);
            } else {
              ok('apply: the settings card is a component');
            }
            const cardProps = typeof card.options.inject === 'function' ? card.options.inject() : null;
            if (cardProps === null || cardProps.scope !== formStub) {
              fail(`apply: the ${expected.slot} injection must hand the ${SETTINGS_NAMESPACE} config form to the card`);
            } else {
              const api = ['getSnapshot', 'subscribe', 'set', 'unset'].filter(
                (method) => typeof cardProps.scope[method] !== 'function',
              );
              if (api.length > 0) fail(`apply: the bound config form is missing ${api.join(', ')}`);
              else ok('apply: the card can read and write the bound config form');
            }
          }
        }

        // Both hosts: the declarative one answers with the shared form, the
        // imperative one with the bound scope, and each gets its own seat.
        checkHost({ withForms: true, withBinder: false }, { host: 'forms', slot: CARD_TAB_SLOT });
        checkHost({ withForms: false, withBinder: true }, { host: 'binder', slot: CARD_SLOT });

        // Degradation: a host that provides no settings surface at all must
        // still get the speaker button, and `apply` must not throw.
        const degraded = makeCtx({ withForms: false, withBinder: false });
        try {
          clientExports.apply(degraded.ctx);
        } catch (error) {
          fail(`apply: mounting on a host without a settings surface threw: ${String(error?.message ?? error)}`);
        }
        if (!degraded.ledger.injections.some((entry) => entry.name === ACTION_SLOT)) {
          fail(`apply: the ${ACTION_SLOT} button must still register when the settings surface is absent`);
        } else if (
          degraded.ledger.injections.some((entry) => entry.name === CARD_SLOT || entry.name === CARD_TAB_SLOT)
        ) {
          fail(`apply: the card must not register when the settings surface is absent`);
        } else {
          ok(`apply: a host without a settings surface keeps ${ACTION_SLOT} and drops the card`);
        }

        // Degradation: the form service exists, but the Host serves no
        // namespace yet — the settings document has not arrived. The card
        // must wait for it, and the button must not care.
        const unserved = makeCtx({ withForms: true, withBinder: false, served: false });
        try {
          clientExports.apply(unserved.ctx);
        } catch (error) {
          fail(`apply: mounting on a host that serves no namespace threw: ${String(error?.message ?? error)}`);
        }
        if (!unserved.ledger.injections.some((entry) => entry.name === ACTION_SLOT)) {
          fail(`apply: the ${ACTION_SLOT} button must still register when the Host serves no namespace`);
        } else if (unserved.ledger.slotRegistrations.some((entry) => entry?.options?.name === CARD_TAB_SLOT)) {
          fail(`apply: the card must not register while the Host serves no namespace`);
        } else {
          ok(`apply: a Host that serves no namespace keeps ${ACTION_SLOT} and drops the card`);
        }
      }
    }
  }
}

// 7. Structural check: the bundle names every seat and no forbidden specifier.
for (const slot of [ACTION_SLOT, CARD_SLOT, CARD_TAB_SLOT]) {
  if (!source.includes(`'${slot}'`) && !source.includes(`"${slot}"`)) {
    fail(`slot: the bundle does not reference ${slot}`);
  }
}
if (!source.includes(SETTINGS_NAMESPACE)) {
  fail(`namespace: the bundle never names ${SETTINGS_NAMESPACE}`);
}
if (!source.includes('settingsScope')) {
  fail('namespace: the bundle never asks for the settings scope binder');
}
if (!source.includes('configForms')) {
  fail('namespace: the bundle never asks for the shared form service');
}
// The plugin's own page: the studio fills its configuration section from
// the two slots below — the bundle's by the package name, the row's by
// `bundle#rowId`. The card must name both, with the exact keys.
for (const slot of ['plugins.bundle.config', 'plugins.row.config']) {
  if (!source.includes(`'${slot}'`) && !source.includes(`"${slot}"`)) {
    fail(`page: the bundle does not reference ${slot}`);
  }
}
if (!source.includes('key: BUNDLE_KEY')) {
  fail('page: the bundle section is never keyed');
}
if (!source.includes('key: ROW_CONFIG_KEY')) {
  fail('page: the row section is never keyed');
}

// 8. Hook order: the settings card returns early while the settings document
// loads and again while the draft is null, so no hook may sit below the first
// guard. React keeps its own hook count per component: a hook that runs only on
// the later render makes the number change, React throws, and the whole
// settings tab disappears from the page. The stub React in `test/settings.mjs`
// allocates hooks by index and cannot see the mistake, so the gate reads the
// source itself and skips comment lines.
{
  const guardLine = source.split('\n').findIndex((line) => /^\s*if \(!ready\) \{\s*$/u.test(line));
  if (guardLine < 0) {
    fail('hooks: the card has no `if (!ready)` guard, so the hook-order check cannot run');
  } else {
    const offender = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), index }))
      .filter((entry) => entry.index > guardLine)
      .find((entry) => {
        if (entry.line.startsWith('//') || entry.line.startsWith('*') || entry.line.startsWith('/*')) return false;
        return /react\.use[A-Z]/u.test(entry.line);
      });
    if (offender === undefined) {
      ok('hooks: every hook of the settings card runs before its first early return');
    } else {
      fail(
        `hooks: a hook sits below the card's early return at line ${String(offender.index + 1)}: ${offender.line} — React will drop the whole card`,
      );
    }
  }
}
// The card's seat must be the bundle-config keyed slot, not the Official list.
if (source.includes(`'${OFFICIAL_ITEM_SLOT}'`)) {
  fail(`slot: the bundle registers into ${OFFICIAL_ITEM_SLOT}, which is the Official group; use ${CARD_SLOT}`);
}

for (const note of notes) console.log(`  ok   ${note}`);
for (const problem of failures) console.error(`  FAIL ${problem}`);

if (failures.length > 0) {
  console.error(`\ndsh-voice-v: client bundle check failed (${failures.length} problem(s))`);
  process.exit(1);
}

console.log(`\ndsh-voice-v: client bundle check passed (${source.length} bytes at lib/client.js)`);

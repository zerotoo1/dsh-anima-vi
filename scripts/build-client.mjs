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
 *     `plugins.item` list instead of this bundle's keyed `plugins.bundle.config`
 *     seat, or is not keyed by the package name the page dispatches on;
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
 * Slot the settings card registers into: a KEYED slot declared by
 * ui-plugin-manager, whose key domain is the npm package name (the page
 * dispatches `{ entryKey: pkg.name }`). Not `plugins.item` — that list is the
 * Official group, and the harness routes a bundle's configuration here instead.
 */
const CARD_SLOT = 'plugins.bundle.config';

/** The list slot the card must NOT be filed into. */
const OFFICIAL_ITEM_SLOT = 'plugins.item';

/**
 * Services the whole browser half must wait for. `configForms` is deliberately
 * not here: it is waited for in a nested `ctx.inject` so its absence cannot
 * suspend the speaker button, which needs only `slots`.
 */
const REQUIRED_SERVICES = ['slots'];

/** Services the settings card's nested fiber must wait for. */
const CARD_SERVICES = ['slots', 'configForms'];

/** Services that must never be declared in the top-level `inject`. */
const OPTIONAL_SERVICES = ['configForms'];

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
         * @param options - whether the host provides `configForms`.
         * @returns the stub context and the ledgers the checks read.
         */
        function makeCtx({ withConfigForms }) {
          const ledger = {
            injections: [],
            slotRegistrations: [],
            formGets: [],
            whileServedCalls: [],
            effectLabels: [],
            nestedInjectServices: [],
            inEffect: false,
            whileServedRegister: null,
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
              // missing `configForms` therefore means the callback never runs.
              const missing = services.filter((service) => service === 'configForms' && !withConfigForms);
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
          };
          if (withConfigForms) {
            fiberFace.configForms = {
              get(entryId) {
                ledger.formGets.push(entryId);
                return formStub;
              },
              whileServed(namespaces, register) {
                ledger.whileServedCalls.push({ namespaces: [...namespaces], inEffect: ledger.inEffect });
                ledger.whileServedRegister = register;
                return () => {};
              },
            };
          }
          return { ctx: fiberFace, ledger, formStub };
        }

        const { ctx: ctxStub, ledger, formStub } = makeCtx({ withConfigForms: true });
        const { injections, slotRegistrations, formGets, whileServedCalls, effectLabels } = ledger;

        try {
          clientExports.apply(ctxStub);
        } catch (error) {
          fail(`apply: mounting against a stub context threw: ${String(error?.message ?? error)}`);
        }

        // The card's nested fiber must ask for `configForms` itself, and for
        // `slots` again — a nested strict scope cannot read what it does not
        // declare.
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

        // The form is keyed by the Host Loader row id, which is the namespace.
        if (formGets.length === 0 || formGets[0] !== SETTINGS_NAMESPACE) {
          fail(
            `apply: configForms.get must be called with the namespace ${JSON.stringify(SETTINGS_NAMESPACE)}, saw ${JSON.stringify(formGets)}`,
          );
        } else {
          ok(`apply: configForms.get(${SETTINGS_NAMESPACE}) binds the card's form`);
        }

        // The card may only exist while the Host serves the namespace, and the
        // watch itself must live on this plugin's fiber.
        if (whileServedCalls.length === 0) {
          fail(`apply: configForms.whileServed was never called (effects seen: ${JSON.stringify(effectLabels)})`);
        } else if (!whileServedCalls.some((call) => call.namespaces.includes(SETTINGS_NAMESPACE))) {
          fail(
            `apply: configForms.whileServed must watch ${JSON.stringify(SETTINGS_NAMESPACE)}, saw ${JSON.stringify(whileServedCalls.map((call) => call.namespaces))}`,
          );
        } else if (!whileServedCalls.some((call) => call.inEffect)) {
          fail('apply: configForms.whileServed must be wrapped in ctx.effect');
        } else {
          ok(`apply: configForms.whileServed([${SETTINGS_NAMESPACE}]) is owned by ctx.effect`);
        }

        // An unserved namespace must not register the card at all: only the
        // watch's registration callback may put it on the ledger.
        if (injections.some((entry) => entry.name === CARD_SLOT)) {
          fail(`apply: ${CARD_SLOT} was injected before the Host served ${SETTINGS_NAMESPACE}`);
        } else if (typeof ledger.whileServedRegister !== 'function') {
          fail('apply: configForms.whileServed received no registration callback');
        } else {
          try {
            ledger.whileServedRegister(new Set([SETTINGS_NAMESPACE]));
          } catch (error) {
            fail(`apply: the whileServed registration threw: ${String(error?.message ?? error)}`);
          }
        }

        // The card must never be filed into the Official group's list seat.
        if (injections.some((entry) => entry.name === OFFICIAL_ITEM_SLOT)) {
          fail(`apply: the card must not register into ${OFFICIAL_ITEM_SLOT} (that list is the Official group)`);
        } else {
          ok(`apply: the card stays out of ${OFFICIAL_ITEM_SLOT}`);
        }

        const names = injections.map((entry) => entry.name);
        for (const slot of [ACTION_SLOT, CARD_SLOT]) {
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

        const card = slotRegistrations.find((entry) => entry?.options?.name === CARD_SLOT);
        if (card === undefined) {
          fail(`apply: no registration carries name ${CARD_SLOT}`);
        } else {
          // Keyed slot: the key is the npm package name the page dispatches on.
          if (card.options.key !== SETTINGS_NAMESPACE) {
            fail(
              `apply: the ${CARD_SLOT} card must be keyed on the package name ${JSON.stringify(SETTINGS_NAMESPACE)}, found ${JSON.stringify(card.options.key)}`,
            );
          } else {
            ok(`apply: ${CARD_SLOT} keyed on ${SETTINGS_NAMESPACE}`);
          }
          // List-only shape fields must not appear on a keyed registration.
          for (const stray of ['id', 'order', 'label']) {
            if (card.options[stray] !== undefined) {
              fail(`apply: the ${CARD_SLOT} keyed entry must not carry ${stray}, found ${JSON.stringify(card.options[stray])}`);
            }
          }
          ok(`apply: ${CARD_SLOT} carries no id/order/label`);
          if (typeof card.component !== 'function') {
            fail(`apply: the ${CARD_SLOT} component is not a function`);
          } else {
            ok('apply: the settings card is a component');
          }
          const cardProps = typeof card.options.inject === 'function' ? card.options.inject() : null;
          if (cardProps === null || cardProps.scope !== formStub) {
            fail(`apply: the ${CARD_SLOT} injection must hand the ${SETTINGS_NAMESPACE} config form to the card`);
          } else {
            const api = ['getSnapshot', 'subscribe', 'set', 'unset'].filter(
              (method) => typeof cardProps.scope[method] !== 'function',
            );
            if (api.length > 0) fail(`apply: the bound config form is missing ${api.join(', ')}`);
            else ok('apply: the card can read and write the bound config form');
          }
        }

        // Degradation: a host that provides no `configForms` must still get the
        // speaker button, and `apply` must not throw during activation.
        const degraded = makeCtx({ withConfigForms: false });
        try {
          clientExports.apply(degraded.ctx);
        } catch (error) {
          fail(`apply: mounting on a host without configForms threw: ${String(error?.message ?? error)}`);
        }
        if (!degraded.ledger.injections.some((entry) => entry.name === ACTION_SLOT)) {
          fail(`apply: the ${ACTION_SLOT} button must still register when configForms is absent`);
        } else if (degraded.ledger.injections.some((entry) => entry.name === CARD_SLOT)) {
          fail(`apply: ${CARD_SLOT} must not register when configForms is absent`);
        } else {
          ok(`apply: a host without configForms keeps ${ACTION_SLOT} and drops the card`);
        }
      }
    }
  }
}

// 7. Structural check: the bundle names both slots and no forbidden specifier.
for (const slot of [ACTION_SLOT, CARD_SLOT]) {
  if (!source.includes(`'${slot}'`) && !source.includes(`"${slot}"`)) {
    fail(`slot: the bundle does not reference ${slot}`);
  }
}
if (!source.includes(SETTINGS_NAMESPACE)) {
  fail(`namespace: the bundle never names ${SETTINGS_NAMESPACE}`);
}
if (!source.includes('whileServed')) {
  fail('namespace: the bundle never gates its card on configForms.whileServed');
}
for (const stale of ['settingsScope', 'settings.plugin.item']) {
  if (source.includes(stale)) fail(`stale: the bundle still references ${stale}`);
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

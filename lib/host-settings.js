/**
 * dsh-voice-v live-settings bridge (Host half).
 *
 * ## Why this module no longer registers anything
 *
 * The Harness no longer exposes `ctx.settings.register(ns, schema, { base })`.
 * Settings namespaces are **derived**: `dsh-settings`' `describe()` reads the
 * namespace from each Loader entry's own `options.id` and takes the schema from
 * `entry.fiber.runtime.Config` — the schemastery `Config` this package exports
 * (see `lib/index.js`). Only fields marked `.volatile()` survive `volatileForm()`,
 * so every user-editable field is volatile here and every deployment-only key is
 * not.
 *
 * Consequence: there is no namespace document for this plugin to own. A save
 * written by the settings card lands in the profile patch as this entry's
 * `config`, the Loader re-validates it against `Config`, and because the six
 * fields are volatile the Loader commits the new values into the *same* volatile
 * references the running fiber already holds (`cordis-plugin-loader`
 * `_commitVolatile` → `cosmokit`'s `updateVolatile`). Reading them is therefore
 * free of any settings service: the object passed to `apply` is re-read on every
 * call and `.get()` always answers with the current value.
 *
 * ## Why the peer is resolved at runtime, synchronously
 *
 * `Config` is read by the fiber as a static module export, so the schema must
 * exist at import time; the asynchronous `import()` the old code used cannot do
 * that. The plugin is installed as a `link:` to a directory outside the profile,
 * and Node resolves a bare specifier from the importing file's REAL path, so a
 * static import would die with `ERR_MODULE_NOT_FOUND` under a plain host.
 *
 * `@deepseek-ai/schemastery` therefore goes through a `createRequire` anchored
 * where a copy actually lives:
 *
 * 1. this module's own URL — the harness's resolver (DSH Studio pins every
 *    `@deepseek-ai/*` specifier to the managed runtime, and `dsh-app-boot` routes
 *    bare specifiers of linked packages) answers this even though the directory
 *    has no `node_modules`;
 * 2. the DSH home's profile `node_modules` (the ordinary install inside a
 *    profile, and the shared `profiles/` fallback).
 *
 * Every candidate is inspected, not just resolved: a copy that cannot mark
 * `.volatile()` is refused. That matters more than it looks — a schema that
 * claims volatility but was built by a schemastery without volatile support
 * would parse to plain values, so the Loader would commit a volatile-only edit
 * into no reference at all and silently drop it. Refusing the copy leaves the
 * namespace unserved instead, which is the honest outcome.
 *
 * Nothing here throws: a deployment that cannot resolve a usable schemastery
 * still loads, still serves every route, and still answers `/config` with
 * `settingsRegistered: false` so the card says the row config is the only layer
 * instead of pretending to save.
 *
 * @module dsh-voice-v/host-settings
 */

import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_NAMESPACE, buildVoiceConfigSchema, resolveVoiceConfig } from './config.js';

/**
 * The only peer this half needs: the schema factory the exported `Config` is
 * built from. `dsh-settings` is the Host's own service and is no longer
 * imported here — it consumes `Config` on the other side of the fence.
 */
export const PEER_SPECIFIERS = Object.freeze(['@deepseek-ai/schemastery']);

/** Specifier of the schema factory, kept apart from the array for the resolver. */
const SCHEMA_SPECIFIER = PEER_SPECIFIERS[0];

/** Absolute path of this package's root directory. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The DSH home directory, honouring `DSH_HOME` and falling back to `~/.dsh`.
 * @param env - Environment to read; defaults to `process.env`.
 * @returns The absolute home path.
 */
export function dshHomeDir(env = process.env) {
  const explicit = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return explicit === '' ? join(homedir(), '.dsh') : explicit;
}

/**
 * Directories whose `node_modules` may hold the peer package, most specific
 * first. The DSH home's `profiles/` fallback is the one that answers for a
 * plugin installed outside the profile; the plugin's own directory answers when
 * it was installed the normal way.
 * @param options - `env` override and the `profileDir` the caller already knows.
 * @returns Absolute anchor file paths, `createRequire`-ready, already deduped.
 */
export function candidateAnchors(options = {}) {
  const env = options.env ?? process.env;
  const anchors = [];
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !anchors.includes(value)) anchors.push(value);
  };

  // 1. Beside the plugin itself: an install inside the profile resolves here.
  push(join(packageRoot, 'x.js'));
  // 2. The running host's own entry script. A plugin installed as a `link:`
  //    lives outside the profile, so nothing beside it can see the
  //    installation's `node_modules`; the host's own script can, and that copy
  //    is the one the running tree was built against. It matters here because
  //    the profile's interception layer may hold an older schemastery whose
  //    `string()` cannot mark fields volatile — a copy that would be rejected
  //    below, leaving the namespace unserved.
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry !== '') {
    try {
      push(join(dirname(resolvePath(entry)), 'x.js'));
    } catch {
      /* an entry that cannot be resolved simply contributes no anchor */
    }
  }
  // 3. Whatever the Host exported for this launch.
  if (typeof options.profileDir === 'string' && options.profileDir !== '') {
    push(join(options.profileDir, 'x.js'));
  }
  if (typeof env?.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.trim() !== '') {
    push(join(env.DSH_PROFILE_DIR.trim(), 'x.js'));
  }
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' && typeof env?.DSH_PROFILE === 'string') {
    push(join(env.DSH_HOME.trim(), 'profiles', env.DSH_PROFILE, 'x.js'));
  }
  // 4. The home's shared fallback, then one anchor per profile (the profile name
  //    is not part of any contract we can import, so the layout is read).
  const home = dshHomeDir(env);
  push(join(home, 'profiles', 'x.js'));
  const profilesDir = join(home, 'profiles');
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) push(join(profilesDir, entry.name, 'x.js'));
    }
  } catch {
    /* no profiles directory: the other anchors still apply */
  }
  // 4. Last resort: the process working directory.
  push(join(process.cwd(), 'x.js'));
  return anchors;
}

/**
 * Resolve one bare specifier from the first anchor that can see it.
 * @param specifier - Package specifier, e.g. `@deepseek-ai/schemastery`.
 * @param anchors - `createRequire` anchors to try in order.
 * @returns The resolved absolute file path, or `null` when no anchor has it.
 */
export function resolvePeerPackage(specifier, anchors) {
  for (const anchor of anchors ?? []) {
    try {
      const resolved = createRequire(anchor).resolve(specifier);
      if (typeof resolved === 'string' && resolved !== '') return resolved;
    } catch {
      /* try the next anchor */
    }
  }
  return null;
}

/**
 * Whether a resolved schema factory can mark fields volatile.
 *
  * Probed rather than assumed: `volatile()` is what makes the user fields
 * live, and a schemastery that predates it still resolves cleanly — it just
 * cannot be trusted with a live form.
 * @param z - The resolved module (or its default export).
 * @returns True when the factory is a usable schemastery.
 */
export function isVolatileSchemaFactory(z) {
  return (
    typeof z === 'function' &&
    typeof z.object === 'function' &&
    typeof z.string === 'function' &&
    typeof z.number === 'function' &&
    typeof z.dict === 'function' &&
    typeof z.any === 'function' &&
    typeof z.union === 'function' &&
    typeof z.string().volatile === 'function'
  );
}

/** Memoized schema load: one attempt per process, whatever the callers. */
let schemaLoad = null;

/**
 * Load the schema factory synchronously, from the first anchor that has a copy
 * that can mark fields volatile.
 *
 * Synchronous on purpose: `Config` is a static export read by the fiber at
 * import time, so the asynchronous `import()` this package used to make cannot
 * answer for it.
 * @param options - `env`/`profileDir`/`anchors` to steer the search, and a
 *   pre-built `z` (tests pass one instead of touching the filesystem).
 * @returns `{ z, anchor, path }`, or `{ missing, reasons }` when nothing
 *   qualified. Never throws.
 */
export function loadSchemaFactory(options = {}) {
  if (options.z !== undefined) return { z: options.z };
  if (schemaLoad !== null) return schemaLoad;

  const anchors = [import.meta.url, ...(Array.isArray(options.anchors) ? options.anchors : candidateAnchors(options))];
  const reasons = [];
  for (const anchor of anchors) {
    let z;
    try {
      z = createRequire(anchor)(SCHEMA_SPECIFIER);
    } catch (error) {
      reasons.push(`${anchor}: ${String(error?.code ?? error?.message ?? error)}`);
      continue;
    }
    try {
      if (!isVolatileSchemaFactory(z)) {
        const resolved = resolvePeerPackage(SCHEMA_SPECIFIER, [anchor]) ?? '<unknown>';
        reasons.push(`${anchor}: ${resolved} cannot mark fields volatile()`);
        continue;
      }
      schemaLoad = { z, anchor, path: resolvePeerPackage(SCHEMA_SPECIFIER, [anchor]) };
      return schemaLoad;
    } catch (error) {
      reasons.push(`${anchor}: ${String(error?.code ?? error?.message ?? error)}`);
    }
  }

  schemaLoad = { missing: [SCHEMA_SPECIFIER], reasons };
  return schemaLoad;
}

/** Drop the memoized schema load. Exposed for tests and for a Host hot reload. */
export function resetPeerCache() {
  schemaLoad = null;
}

/** Why the exported `Config` is absent; empty when it is present. */
let schemaReasons = loadSchemaFactory().reasons ?? [];

/**
 * The Config schema the Loader validates this entry's `config` against.
 *
 * `undefined` when no volatile-capable schemastery could be loaded: the plugin
 * then runs off the raw row config, `/config` reports the namespace as not
 * served, and nothing above the route layer changes.
 */
export const Config = (() => {
  const loaded = loadSchemaFactory();
  if (loaded.z === undefined) return undefined;
  try {
    return buildVoiceConfigSchema(loaded.z);
  } catch (error) {
    schemaReasons.push(`schema build failed: ${String(error?.message ?? error)}`);
    return undefined;
  }
})();

/** Whether the settings form exists at all for this namespace. */
export const SETTINGS_SCHEMA_AVAILABLE = Config !== undefined;

/**
 * The Loader entry id owning this fiber, if the Host exposes it.
 *
 * `entry.options.id` is the row id, and it is the field the Host itself keys
 * the settings namespace by: `dsh-settings` publishes every live row as
 * `ns: entry.options.id` and resolves a write by `row.options.id === ns`. The
 * loader's `entry.id` is a different thing — a *composed* path that prefixes
 * the id of the owning subtree (`include:row`, `group:row`) — so it is never
 * the namespace key and must not be read as one.
 * @param ctx - Host context; `.fiber.entry` is assigned by `cordis-plugin-loader`.
 * @returns The row id, or `undefined` when it cannot be read.
 */
export function entryIdOf(ctx) {
  try {
    const rowId = ctx?.fiber?.entry?.options?.id;
    return typeof rowId === 'string' && rowId !== '' ? rowId : undefined;
  } catch {
    return undefined;
  }
}

/** The shared reference protocol `@deepseek-ai/cosmokit` implements. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * Whether a value is an unevaluated `Volatile` reference rather than plain data.
 *
 * `cosmokit` decides the same way (`write in value`) across every copy of the
 * library, because the key is a global registry symbol; the `Object.keys` check
 * is the belt for a factory that ever stops registering it.
 * @param value - Candidate value from a parsed config.
 * @returns True when `value` answers `get()`.
 */
export function isVolatileRef(value) {
  if (value === null || typeof value !== 'object') return false;
  if (typeof value.get !== 'function') return false;
  return VOLATILE_WRITE in value || Object.keys(value).length === 0;
}

/**
 * Replace every volatile reference with the plain value it holds.
 *
 * This is `dsh-settings`' `plainConfig`, kept local because the peer is not
  * imported here: a parsed config mixes volatile references (the fields a
 * user edits, whose contents change under the plugin) with plain deployment
 * keys, and `resolveVoiceConfig` reads plain values only.
 * @param value - A parsed config, or any value inside one.
 * @returns The same shape with every reference unwrapped.
 */
export function unwrapVolatile(value) {
  if (isVolatileRef(value)) return unwrapVolatile(value.get());
  if (Array.isArray(value)) return value.map((item) => unwrapVolatile(item));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const plain = {};
    for (const [key, child] of Object.entries(value)) plain[key] = unwrapVolatile(child);
    return plain;
  }
  return value;
}

/**
 * Read the live voice settings off the config the Host handed this plugin.
 *
 * `entryConfig` is the parsed config: the Loader already merged the bundle layer
  * and the profile patch into it, so the volatile fields *are* the user's
 * section, and their references are updated in place on every save. Reading
 * `.get()` per call is what keeps a new value on the next sentence without a
 * remount; when no `Config` schema was published the same object holds plain
 * values and the unwrap is a no-op.
 *
 * @param ctx - Host context; `ctx.logger` is read lazily.
 * @param entryConfig - The parsed config object passed to `apply`.
 * @param options - `logger`.
 * @returns `() => resolvedVoiceSettings`, plus `settingsRegistered()`.
 */
export function createLiveSettings(ctx, entryConfig, options = {}) {
  const logger = options.logger;
  const warn = (message) => {
    if (logger !== undefined && typeof logger.warn === 'function') logger.warn(message);
  };

  if (Config === undefined) {
    warn(
      `dsh-voice-v: settings namespace "${SETTINGS_NAMESPACE}" is not served (${
        schemaReasons === null || schemaReasons.length === 0 ? 'no resolvable peer package' : schemaReasons.join('; ')
      }); the plugin row config is the only layer`,
    );
  }

  let mismatchWarned = false;

  const liveSettings = function liveSettings() {
    return resolveVoiceConfig(unwrapVolatile(entryConfig));
  };

  /**
   * Whether the settings card can edit this namespace.
   *
   * True only when this half published a volatile schema *and* the Loader row
   * that mounts it carries the namespace id. A row that still mounts the plugin
   * under another id (say a legacy `voice-v`) is answered `false` rather than
   * letting the card save into a namespace that will never be described.
   * @returns True when `dsh-settings.describe()` will list this namespace.
   */
  liveSettings.settingsRegistered = () => {
    if (Config === undefined) return false;
    const id = entryIdOf(ctx);
    if (id !== undefined && id !== SETTINGS_NAMESPACE) {
      if (mismatchWarned === false) {
        mismatchWarned = true;
        warn(
          `dsh-voice-v: the settings namespace "${SETTINGS_NAMESPACE}" is not served because this plugin is mounted as "${id}"; rename the Loader row to "${SETTINGS_NAMESPACE}" or move the id to the patch layer`,
        );
      }
      return false;
    }
    return true;
  };

  return liveSettings;
}

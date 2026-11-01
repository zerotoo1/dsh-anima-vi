/**
 * dsh-voice-v live-settings bridge (Host half).
 *
 * ## How the namespace is published
 *
 * The Harness exposes `ctx.settings.register(ns, schema, { base })` on the
 * 0.1.x settings service: a plugin publishes its own namespace, and the
 * service serves it. The row config is the *base* layer of that namespace, the
 * user's document the layer above it, and a save through the card lands in the
 * user's layer without a Loader restart.
 *
 * The schema is a plain one — no `.volatile()` marker. A volatile field parses
 * to a live reference rather than a value, and the 0.1.x service resolves
 * ordinary values: a reader could not tell a true flag from a reference to
 * `false`.
 *
 * ## How the peer is resolved at runtime
 *
 * `Config` is read by the fiber as a static module export, so the schema must
 * exist at import time. The plugin is installed as a `link:` to a directory
 * outside the profile, and Node resolves a bare specifier from the importing
 * file's REAL path, so a static import would die with `ERR_MODULE_NOT_FOUND`
 * under a plain host.
 *
 * `@deepseek-ai/schemastery` therefore goes through a `createRequire` anchored
 * where a copy actually lives, and the copy is imported as ESM: the CommonJS
 * build requires `@deepseek-ai/cosmokit`, which is ESM, and loading it while
 * the loader is still evaluating that module raises
 * `ERR_REQUIRE_ESM_RACE_CONDITION`.
 *
 * The Host's own copy is the one that answers first, and it is the right one:
 * the settings service validates a namespace with the very same schemastery.
 * The profile's store holds a newer copy as well, and it is used when the Host
 * has none.
 *
 * Nothing here throws: a deployment that cannot resolve a usable schemastery
 * still loads, still serves every route, and still answers `/config` with
 * `settingsRegistered: false` so the card says the row config is the only layer
 * instead of pretending to save.
 *
 * @module dsh-voice-v/host-settings
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETTINGS_NAMESPACE, buildSettingsSchema, buildVoiceConfigSchema, resolveVoiceConfig } from './config.js';

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
  //    is the one the running tree was built against — and the one the settings
  //    service itself validates a namespace with.
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
  //
  // Every profile is walked, not only the running one: the plugin is mounted
  // into a profile it may know nothing about, and the only copy of a usable
  // schemastery may sit in another profile's store.
  const home = dshHomeDir(env);
  push(join(home, 'profiles', 'x.js'));
  const profilesDir = join(home, 'profiles');
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      push(join(profilesDir, entry.name, 'x.js'));
      // pnpm's hidden hoist directory: `node_modules/.pnpm/node_modules`.
      //
      // This one matters. A profile's own `node_modules` holds only its
      // direct dependencies; every transitive package lives in
      // `.pnpm/<name>@<version>` and is linked into `.pnpm/node_modules` — a
      // directory nothing outside pnpm's layout thinks to look in. The
      // profile's copy of schemastery is reachable only from here.
      push(join(profilesDir, entry.name, 'node_modules', '.pnpm', 'node_modules', 'x.js'));
    }
  } catch {
    /* no profiles directory: the other anchors still apply */
  }
  // The profile this run was told about, whether or not it is in the home.
  for (const profile of [options.profileDir, env?.DSH_PROFILE_DIR]) {
    if (typeof profile === 'string' && profile.trim() !== '') {
      push(join(profile.trim(), 'x.js'));
      push(join(profile.trim(), 'node_modules', '.pnpm', 'node_modules', 'x.js'));
    }
  }
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' && typeof env?.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== '') {
    push(join(env.DSH_HOME.trim(), 'profiles', env.DSH_PROFILE.trim(), 'node_modules', '.pnpm', 'node_modules', 'x.js'));
  }
  // 5. Last resort: the process working directory.
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
 * Whether a resolved schema factory can build a namespace schema.
 *
  * Probed rather than assumed: the Host validates a namespace with its own
 * schemastery, so the copy this plugin builds the schema with has to be a real
 * one — the constructs below are the ones the schemas use.
 * @param z - The resolved module (or its default export).
 * @returns True when the factory is a usable schemastery.
 */
export function isSchemaFactory(z) {
  return (
    typeof z === 'function' &&
    typeof z.object === 'function' &&
    typeof z.string === 'function' &&
    typeof z.number === 'function' &&
    typeof z.dict === 'function' &&
    typeof z.any === 'function' &&
    typeof z.union === 'function'
  );
}

/** Memoized schema load: one attempt per process, whatever the callers. */
let schemaLoad = null;

/**
 * The package root a resolved file belongs to.
 * @param {string} filePath - An absolute path inside a package.
 * @returns {string|null} The directory that holds the package's manifest, or null.
 */
export function packageRootOf(filePath) {
  let directory = dirname(filePath);
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * The ESM entry of the package a resolved path belongs to.
 *
 * A package that ships two builds — a `require` condition and an `import`
 * condition — must be loaded through the ESM one. The CJS build pulls its own
 * dependencies in with `require()`, and requiring an ES module that the loader
 * is evaluating at that very moment is a race
 * (`ERR_REQUIRE_ESM_RACE_CONDITION`) this plugin cannot win: it is loaded by
 * the very loader that is still loading that module. The ESM loader has no
 * such race.
 *
 * @param {string} resolvedPath - An absolute path inside the package.
 * @returns {string} The absolute path of the ESM entry, or the given path.
 */
export function esmEntryOf(resolvedPath) {
  const root = packageRootOf(resolvedPath);
  if (root === null) return resolvedPath;
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const entry = manifest.exports?.['.'];
    const candidates = [];
    if (typeof entry === 'string') candidates.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof entry.import === 'string') {
      candidates.push(entry.import);
    }
    if (typeof manifest.module === 'string') candidates.push(manifest.module);
    for (const candidate of candidates) {
      const absolute = join(root, candidate);
      if (existsSync(absolute)) return absolute;
    }
  } catch {
    /* the resolved path stays the fallback */
  }
  return resolvedPath;
}

/**
 * Whether a schema factory knows the `.volatile()` marker.
 *
 * The declarative settings service builds its form from the volatile fields
 * only, so a copy without the marker would describe the entry with no form
 * at all. The marker is probed rather than assumed: the copies in the wild
 * differ, and the one this plugin builds its schema with decides whether the
 * card has something to edit.
 * @param {object} z - The resolved module (or its default export).
 * @returns {boolean} True when the factory can mark a field volatile.
 */
export function supportsVolatile(z) {
  try {
    return typeof z?.string?.()?.volatile === 'function';
  } catch {
    return false;
  }
}

/**
 * Pick the schema factory out of a loaded module.
 * @param {object} module - The imported namespace.
 * @returns {object|null} The factory, or null when the module is not a usable schemastery.
 */
export function pickSchemaFactory(module) {
  if (isSchemaFactory(module)) return module;
  if (module !== null && typeof module === 'object' && isSchemaFactory(module.default)) {
    return module.default;
  }
  return null;
}

/**
 * Load the schema factory from the first anchor that has a usable copy.
 *
 * The load is asynchronous, and the module awaits it once: `Config` is a
 * static export read by the fiber right after the import settles, and a
 * top-level await is exactly the way to have it ready by then.
 * @param options - `env`/`profileDir`/`anchors` to steer the search, and a
 *   pre-built `z` (tests pass one instead of touching the filesystem).
 * @returns A promise of `{ z, anchor, path }`, or `{ missing, reasons }` when
 *   nothing qualified. Never throws.
 */
export async function loadSchemaFactory(options = {}) {
  if (options.z !== undefined) return { z: options.z };
  if (schemaLoad !== null) return schemaLoad;

  const anchors = [import.meta.url, ...(Array.isArray(options.anchors) ? options.anchors : candidateAnchors(options))];
  const reasons = [];
  let fallback = null;
  for (const anchor of anchors) {
    const resolved = resolvePeerPackage(SCHEMA_SPECIFIER, [anchor]);
    if (resolved === null) {
      reasons.push(`${anchor}: ${SCHEMA_SPECIFIER} was not found`);
      continue;
    }
    const esmPath = esmEntryOf(resolved);
    let module;
    try {
      module = await import(pathToFileURL(esmPath).href);
    } catch (error) {
      reasons.push(`${anchor}: ${esmPath} could not be loaded — ${String(error?.message ?? error)}`);
      continue;
    }
    const z = pickSchemaFactory(module);
    if (z === null) {
      reasons.push(`${anchor}: ${resolved} cannot build a namespace schema`);
      continue;
    }
    // A copy that knows the marker is preferred: the declarative settings
    // service derives the card's form from the volatile fields, and a copy
    // without them describes the entry with no form at all. The first usable
    // copy stays the fallback, so a deployment with one old schemastery still
    // loads the plugin — it just has no card to show.
    if (supportsVolatile(z)) {
      schemaLoad = { z, anchor, path: esmPath };
      return schemaLoad;
    }
    fallback = fallback ?? { z, anchor, path: esmPath };
  }

  if (fallback !== null) {
    schemaLoad = fallback;
    return schemaLoad;
  }

  schemaLoad = { missing: [SCHEMA_SPECIFIER], reasons };
  return schemaLoad;
}

/** Drop the memoized schema load. Exposed for tests and for a Host hot reload. */
export function resetPeerCache() {
  schemaLoad = null;
}

/** Why the exported `Config` is absent; empty when it is present. */
let schemaReasons = [];

/** The schema factory the schemas below are built from. */
let loadedSchema = null;

/**
 * The Config schema the Loader validates this entry's `config` against.
 *
 * `undefined` when no usable schemastery could be loaded: the plugin
 * then runs off the raw row config, `/config` reports the namespace as not
 * served, and nothing above the route layer changes.
 */
export const Config = await (async () => {
  const loaded = await loadSchemaFactory();
  schemaReasons = loaded.reasons ?? [];
  if (loaded.z === undefined) return undefined;
  loadedSchema = loaded.z;
  try {
    // Volatile fields only when the resolved schemastery knows the marker:
    // the declarative settings service derives the card's form from them.
    return buildVoiceConfigSchema(loaded.z, { volatile: supportsVolatile(loaded.z) });
  } catch (error) {
    schemaReasons.push(`schema build failed: ${String(error?.message ?? error)}`);
    return undefined;
  }
})();

/**
 * The schema the settings namespace is registered with.
 *
 * The imperative settings service (the 0.1.x one) resolves values ITSELF, so
 * a volatile field would arrive at the reader as a live reference instead of
 * as data. The registered schema is therefore the plain variant; the exported
 * `Config` keeps the volatile markers the declarative service needs.
 *
 * `undefined` when no schemastery could be loaded: the namespace is then not
 * registered at all, and the plugin runs off its row config.
 */
export const SettingsSchema = (() => {
  if (loadedSchema === null) return undefined;
  try {
    return buildSettingsSchema(loadedSchema, { volatile: false });
  } catch (error) {
    schemaReasons.push(`settings schema build failed: ${String(error?.message ?? error)}`);
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

  // The row config is the composition layer: the deployment keys and the
  // card fields the row itself sets. Two hosts read it:
  //
  //   * the declarative service folds the user's document into the row and
  //     the row config already carries it, so the row IS the live value;
  //   * the imperative service keeps the user's document in its own layer,
  //     and `scope.get()` answers the merged value.
  // The row is read FRESH on every call. The card's fields inside it are
  // volatile references, and a save rewrites the reference IN PLACE — the
  // object keeps its identity, its contents change. A snapshot taken at mount
  // would keep serving the values the plugin started with, and the card would
  // show a setting the host changed under it: the user picks a provider, saves,
  // and the card falls back to the default it was born with.
  const readRow = () => unwrapVolatile(entryConfig);
  let source = readRow;
  let registered = false;

  const liveSettings = function liveSettings() {
    return resolveVoiceConfig(source());
  };

  /**
   * Whether the settings card can edit this namespace.
   *
   * True only when this half published a schema *and* the Loader row that
   * mounts it carries the namespace id. A row that still mounts the plugin
   * under another id (say a legacy `voice-v`) is answered `false` rather than
   * letting the card save into a namespace that will never be described.
   * @returns True when the namespace is registered with the settings service.
   */
  liveSettings.settingsRegistered = () => registered;

  if (SettingsSchema === undefined) {
    warn(
      `dsh-voice-v: settings namespace "${SETTINGS_NAMESPACE}" is not registered (${
        schemaReasons === null || schemaReasons.length === 0 ? 'no resolvable peer package' : schemaReasons.join('; ')
      }); the plugin row config is the only layer`,
    );
    return liveSettings;
  }

  const id = entryIdOf(ctx);
  if (id !== undefined && id !== SETTINGS_NAMESPACE) {
    warn(
      `dsh-voice-v: the settings namespace "${SETTINGS_NAMESPACE}" is not registered because this plugin is mounted as "${id}"; rename the Loader row to "${SETTINGS_NAMESPACE}"`,
    );
    return liveSettings;
  }

  // Two shapes of the settings service exist in the wild, and this plugin
  // answers both. The imperative one (0.1.x) wants a plugin to publish its
  // namespace; the declarative one (0.1.7) derives the namespace from the
  // Loader row and the exported `Config`.
  try {
    ctx.inject?.(['settings'], (sctx) => {
      const service = sctx?.settings;
      if (service === null || service === undefined || typeof service.register !== 'function') {
        // The 0.2.x service: the namespace is derived from the Loader row and
        // its schema is the exported `Config`. There is nothing to register.
        // The row IS the live value: the declarative service folds the user's
        // document into the row it reads, and the row's card fields are
        // volatile references the Host rewrites IN PLACE on every save. So the
        // row is read fresh here — a snapshot taken at mount would answer with
        // the values the plugin was born with, and the card would undo every
        // change the user made the moment it looked at the host.
        source = readRow;
        // The Host published this namespace itself: it describes the row under
        // `ns: entry.options.id`, and this row is mounted under the namespace
        // id (checked above). The card can write here.
        registered = id === SETTINGS_NAMESPACE;
        return;
      }
      let scope = null;
      try {
        scope = service.register(SETTINGS_NAMESPACE, SettingsSchema, { base: readRow() });
      } catch (error) {
        warn(
          `dsh-voice-v: the settings namespace "${SETTINGS_NAMESPACE}" could not be registered — ${String(error?.message ?? error)}`,
        );
        source = readRow;
        return;
      }
      registered = true;
      source = () => ({ ...readRow(), ...scope.get() });
      scope.watch(() => {
        options.onChange?.();
      });
      options.onChange?.();
    });
  } catch (error) {
    warn(`dsh-voice-v: the settings namespace could not be registered — ${String(error?.message ?? error)}`);
  }

  return liveSettings;
}

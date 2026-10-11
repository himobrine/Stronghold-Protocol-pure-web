// server/dataGetters.js — pure game-data getters, independent of Node's fs (PRD M2).
//
// server/data.js used to own both the fs loader and the index getters, so bundling the lobby
// (server/lobby.js) or the match helpers into a browser pulled `node:fs` along. The getters are
// pure lookups over an already-loaded data object; only the *default* argument needs the
// process-wide singleton, which lives in data.js. To keep this module fs-free, the default is
// resolved through an injected provider that the host sets once at startup:
//
//   * Node server — server/index.js already passes an explicit `getData` into the Lobby, and the
//     match helpers fall back to the provider set by data.js (see `setDefaultDataProvider`).
//   * Browser host — host/entry.js sets the provider to its fetch-loaded data.
//
// A getter called with no default provider and no explicit `data` argument throws a clear error
// instead of silently returning null, so a wiring mistake fails loudly rather than looking like
// missing game data.
//
// Index getters (DESIGN §2; same names as public/js/data.js): getChess, getBond, getGarrison,
// getItem, getBand, getEffect, getEnemy, getWave, getStage, getBoss, getToken, getConfig, getMode.
// The id-keyed files are already `{ [id]: record }` maps (docs/DATA.md), so a getter is an
// OWN-property lookup: ids that come from client intents (e.g. `g.band {bandId: "constructor"}`)
// can never resolve to inherited Object.prototype members. Every getter returns null for unknown
// ids / missing files and takes an optional data object (default: the default provider's data).

/** @type {(() => Readonly<Record<string, any>>) | null} */
let defaultProvider = null;

/**
 * Install the process-wide data provider used when a getter is called without an explicit
 * `data` argument. Called once by the host (server/data.js on Node, the browser host entry).
 * @param {(() => Readonly<Record<string, any>>) | null} provider
 */
export function setDefaultDataProvider(provider) { defaultProvider = provider; }

/** Drop the provider (tests / hot reload). */
export function resetDefaultDataProvider() { defaultProvider = null; }

/** The default data object for a getter called without an explicit `data` argument. */
function defaultData() {
  if (!defaultProvider) {
    throw new Error('[data] no default data provider installed — pass an explicit data object or call setDefaultDataProvider()');
  }
  return defaultProvider();
}

/** Recursively freeze an object graph (iterative; safe for deep JSON). Returns the same object. */
export function deepFreeze(root) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const o = stack.pop();
    if (o === null || typeof o !== 'object' || seen.has(o)) continue;
    seen.add(o);
    for (const v of Object.values(o)) if (v !== null && typeof v === 'object') stack.push(v);
    Object.freeze(o);
  }
  return root;
}

/** Data files that are `{ [id]: record }` maps, with the getter name exported for each. */
export const INDEXED_FILES = Object.freeze({
  chess: 'getChess', bonds: 'getBond', garrisons: 'getGarrison', items: 'getItem', bands: 'getBand',
  effects: 'getEffect', enemies: 'getEnemy', waves: 'getWave', stages: 'getStage', bosses: 'getBoss', tokens: 'getToken',
});

/** Own-property record lookup in a plain-object map; null for anything else. */
function ownRecord(map, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.hasOwn(map, id)) return null;
  const rec = map[id];
  return rec !== null && typeof rec === 'object' ? rec : null;
}

/**
 * Record by id from an id-keyed data file (own properties only; never throws).
 * @param {string} file data file basename, e.g. 'chess'
 * @param {unknown} id record id
 * @param {Readonly<Record<string, any>>} [data] data object (default: the default provider)
 * @returns {any | null}
 */
export function lookup(file, id, data) {
  const d = data === undefined ? defaultData() : data;
  if (!d || typeof d !== 'object' || typeof file !== 'string' || !Object.hasOwn(d, file)) return null;
  return ownRecord(d[file], id);
}

/** @param {unknown} id chess id (normal `_a` or elite `_b`) @param {object} [data] */
export const getChess = (id, data) => lookup('chess', id, data);
/** @param {unknown} id bond id, e.g. 'yanShip' @param {object} [data] */
export const getBond = (id, data) => lookup('bonds', id, data);
/** @param {unknown} id garrison (特质) id @param {object} [data] */
export const getGarrison = (id, data) => lookup('garrisons', id, data);
/** @param {unknown} id item chess id @param {object} [data] */
export const getItem = (id, data) => lookup('items', id, data);
/** @param {unknown} id band (strategy) id @param {object} [data] */
export const getBand = (id, data) => lookup('bands', id, data);
/** @param {unknown} id effect id @param {object} [data] */
export const getEffect = (id, data) => lookup('effects', id, data);
/** @param {unknown} key enemy key @param {object} [data] */
export const getEnemy = (key, data) => lookup('enemies', key, data);
/** @param {unknown} id wave template id @param {object} [data] */
export const getWave = (id, data) => lookup('waves', id, data);
/** @param {unknown} id stage id @param {object} [data] */
export const getStage = (id, data) => lookup('stages', id, data);
/** @param {unknown} id boss id @param {object} [data] */
export const getBoss = (id, data) => lookup('bosses', id, data);
/** @param {unknown} id token id @param {object} [data] */
export const getToken = (id, data) => lookup('tokens', id, data);

/**
 * data/config.json, or null when missing.
 * @param {Readonly<Record<string, any>>} [data]
 * @returns {any | null}
 */
export function getConfig(data) {
  const d = data === undefined ? defaultData() : data;
  const cfg = d && typeof d === 'object' && Object.hasOwn(d, 'config') ? d.config : null;
  return cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : null;
}

/**
 * Mode record `config.modes[modeId]` (e.g. 'mode_multi_hard'), or null.
 * @param {unknown} modeId
 * @param {Readonly<Record<string, any>>} [data]
 * @returns {any | null}
 */
export function getMode(modeId, data) {
  const cfg = getConfig(data);
  return cfg ? ownRecord(cfg.modes, modeId) : null;
}

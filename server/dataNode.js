// server/dataNode.js — the Node-only loader half of server/data.js: the fs reader, the repository
// paths and the process-wide singleton.
//
// Split from server/data.js (PRD M2): that module is now browser-safe (pure getters + the data
// provider), so the lobby/match/sim graph can bundle into a page without pulling in node:fs. Only
// the Node host imports this file — server/index.js at boot and the tests. The getters
// (getConfig, getMode, lookup, getChess, …) live in server/dataGetters.js and are re-exported by
// both halves, so Node callers keep importing from server/data.js unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepFreeze } from './dataGetters.js';

/** Repository root (…/Stronghold-Protocol). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Default data directory. */
export const DATA_DIR = path.join(ROOT, 'data');

/** Files the game expects (a warning lists the missing ones). */
export const DATA_FILES = Object.freeze([
  'config', 'chess', 'bonds', 'garrisons', 'items', 'bands', 'effects', 'choices',
  'enemies', 'factions', 'waves', 'stages', 'bosses', 'tokens', 'assets', 'backups',
]);

/**
 * Read every `*.json` in `dir` into `{ [basename]: parsed }`, deep-frozen.
 * Never throws: an unreadable directory yields `{}`; bad files are skipped with an error log.
 * @param {string} [dir] data directory (default ROOT/data)
 * @param {{ log?: { warn: Function, error: Function, info?: Function }, expected?: readonly string[] }} [opts]
 * @returns {Readonly<Record<string, any>>}
 */
export function loadData(dir = DATA_DIR, { log = console, expected = DATA_FILES } = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.json'))
      .map((d) => d.name)
      .sort();
  } catch (e) {
    log.warn(`[data] cannot read ${dir}: ${e.code || e.message} — running without game data`);
  }
  for (const file of names) {
    const key = file.slice(0, -'.json'.length);
    try {
      out[key] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      log.error(`[data] skipping ${file}: ${e.message}`);
    }
  }
  const missing = expected.filter((k) => !(k in out));
  if (missing.length) log.warn(`[data] missing data files: ${missing.map((k) => k + '.json').join(', ')}`);
  return deepFreeze(out);
}

/** @type {Readonly<Record<string, any>> | null} */
let singleton = null;

/**
 * Process-wide data singleton; loads on first call (later calls ignore the options).
 * @param {{ dir?: string, log?: object }} [opts]
 * @returns {Readonly<Record<string, any>>}
 */
export function getData({ dir = DATA_DIR, log = console } = {}) {
  if (!singleton) singleton = loadData(dir, { log });
  return singleton;
}

/** Drop the singleton so the next getData() reloads (tests / hot reload). */
export function resetData() { singleton = null; }

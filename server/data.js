// server/data.js — the game-data facade over an injected data object, browser-safe by design.
//
// Every `*.json` in data/ becomes a top-level key named after its basename (config, chess, bonds,
// …). The getters (DESIGN §2; same names as public/js/data.js) are pure lookups in
// server/dataGetters.js over an already-loaded object; the default argument resolves through a
// provider installed there (setDefaultDataProvider). Getters never throw on unknown ids /
// missing files: they return null. A getter with no explicit data and no provider installed
// throws (dataGetters.js defaultData), so a wiring mistake fails loudly instead of looking like
// missing game data.
//
// This module holds no Node API and no loader: PRD M2 bundles the lobby/match/sim graph into the
// browser host runtime, and node:fs must never reach that graph. The fs reader, the repository
// paths and the process-wide singleton live in server/dataNode.js, re-exported here so Node
// callers (tests, tools, match helpers) keep one import path. The browser never loads this file
// from disk: server/http/static.js serves a DATA_SHIM_JS stand-in at /data.js (getSimData), and
// tools/build-host.mjs stubs the dataNode re-export so the bundle stays fs-free. The browser host
// (host/entry.js) installs its fetched data via setDefaultDataProvider.

import { lookup, getChess, getBond, getGarrison, getItem, getBand, getEffect, getEnemy,
  getWave, getStage, getBoss, getToken, getConfig, getMode, INDEXED_FILES,
  setDefaultDataProvider, resetDefaultDataProvider } from './dataGetters.js';

export { lookup, getChess, getBond, getGarrison, getItem, getBand, getEffect, getEnemy,
  getWave, getStage, getBoss, getToken, getConfig, getMode, INDEXED_FILES,
  setDefaultDataProvider, resetDefaultDataProvider };

// Node-only loader (fs + the process-wide getData/resetData/loadData singleton). The browser host
// bundle stubs this module (tools/build-host.mjs); a page never reaches these exports.
export { ROOT, DATA_DIR, DATA_FILES, loadData, getData, resetData } from './dataNode.js';

'use strict';
/**
 * canopen_eds.js  v1
 * ─────────────────────────────────────────────────────────────────────────────
 * CiA 306 EDS (Electronic Data Sheet) file parser.
 *
 * What it does:
 *   1. Parses .eds files (INI-format, no external dependencies)
 *   2. Builds a full Object Dictionary compatible with CANopenNode.od
 *   3. Extracts TPDO/RPDO signal maps for use with mapPDOSignals()
 *   4. Extracts RPDO COB-IDs for registerRPDO()
 *
 * API:
 *   const eds = parseEDS('servo_drive.eds')
 *   loadEDSIntoNode(node, eds)             populate node.od from EDS
 *   buildSimulatorPDOMaps(eds, nodeId)     returns PDO_MAPS slice for simulator
 *
 * EDS object types (CiA 306):
 *   0x07 = VAR, 0x08 = ARRAY, 0x09 = RECORD
 *
 * EDS data types:
 *   0x0002 = INTEGER8,    0x0003 = INTEGER16,   0x0004 = INTEGER32
 *   0x0005 = UNSIGNED8,   0x0006 = UNSIGNED16,  0x0007 = UNSIGNED32
 *   0x0009 = VISIBLE_STRING
 */

const fs   = require('fs');
const path = require('path');

// ── Data type → { bitLength, signed } ────────────────────────────────────────
const DATA_TYPES = {
  0x0001: { bitLength: 1,  signed: false, name: 'BOOLEAN' },
  0x0002: { bitLength: 8,  signed: true,  name: 'INTEGER8' },
  0x0003: { bitLength: 16, signed: true,  name: 'INTEGER16' },
  0x0004: { bitLength: 32, signed: true,  name: 'INTEGER32' },
  0x0005: { bitLength: 8,  signed: false, name: 'UNSIGNED8' },
  0x0006: { bitLength: 16, signed: false, name: 'UNSIGNED16' },
  0x0007: { bitLength: 32, signed: false, name: 'UNSIGNED32' },
  0x0009: { bitLength: 0,  signed: false, name: 'VISIBLE_STRING' },
  0x000A: { bitLength: 0,  signed: false, name: 'OCTET_STRING' },
  0x0010: { bitLength: 24, signed: true,  name: 'INTEGER24' },
  0x0015: { bitLength: 40, signed: true,  name: 'INTEGER40' },
  0x001B: { bitLength: 24, signed: false, name: 'UNSIGNED24' },
};

// ── Parse .eds INI format into sections ──────────────────────────────────────
function parseINI(text) {
  const sections = {};
  let current    = null;

  for (let rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1).trim();
      sections[current] = {};
      continue;
    }
    if (current && line.includes('=')) {
      const eq  = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().split(';')[0].trim();  // strip inline comments
      sections[current][key] = val;
    }
  }
  return sections;
}

// ── Parse a numeric string (hex or decimal) ───────────────────────────────────
/**
 * Parse a numeric string, including $NODEID+0x... expressions.
 * @param {string} s
 * @param {number} [nodeId=0]  substituted for $NODEID
 */
/**
 * Parse a numeric string, including $NODEID+0x... expressions (CiA 301 §7).
 * @param {string}  s
 * @param {number} [nodeId=0]  value substituted for $NODEID
 */
function toNum(s, nodeId) {
  if (!s || s === '') return 0;
  s = s.trim();
  if (s.includes('$NODEID')) {
    const id = nodeId || 0;
    // Substitute the literal $NODEID with the decimal nodeId and evaluate
    const expr = s.replace(/\$NODEID/g, id.toString(10));
    // Safe eval: only digits, hex, + (no other operators possible in EDS)
    try {
      const parts = expr.split('+').map(p => p.trim());
      return parts.reduce((acc, p) => {
        if (p.startsWith('0x') || p.startsWith('0X')) return acc + parseInt(p, 16);
        const n = parseInt(p, 10);
        return acc + (isNaN(n) ? 0 : n);
      }, 0);
    } catch { return id; }
  }
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
  return parseInt(s, 10);
}

// ── Check if a section name is an OD object (4-char hex) ─────────────────────
const OD_RE      = /^([0-9A-Fa-f]{4})$/;
const SUBIDX_RE  = /^([0-9A-Fa-f]{4})sub([0-9A-Fa-f]+)$/i;

// ── Parse a single OD entry from an INI section ───────────────────────────────
function parseODEntry(sec) {
  return {
    name:        sec.ParameterName  || 'Unknown',
    objectType:  toNum(sec.ObjectType   || '0x07'),
    dataType:    toNum(sec.DataType     || '0x0007'),
    access:      (sec.AccessType  || 'rw').toLowerCase(),
    value:       parseDefaultValue(sec.DefaultValue, toNum(sec.DataType || '0x0007')),
    pdo:         sec.PDOMapping === '1',
    subNumber:   toNum(sec.SubNumber || '0'),
    scaleFactor: sec.ScaleFactor !== undefined ? parseFloat(sec.ScaleFactor) : 1,
    offset:      sec.Offset      !== undefined ? parseFloat(sec.Offset)      : 0,
  };
}

function parseDefaultValue(raw, dataType) {
  if (!raw || raw === '') return 0;
  const info = DATA_TYPES[dataType];
  if (info && info.name === 'VISIBLE_STRING') return raw.replace(/^"|"$/g, '');
  return toNum(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: parseEDS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parse an EDS file and return a structured description.
 * @param {string} filePath   path to the .eds file
 * @returns {EDSData}
 *   .deviceInfo    { vendorName, productName, productCode, ... }
 *   .od            CANopenNode-compatible object dictionary
 *   .tpdoMaps      { 1: { cobId, transmitType, signals }, ... }
 *   .rpdoMaps      { 1: { cobId, signals }, ... }
 */
function parseEDS(filePath, nodeId) {
  const text     = fs.readFileSync(filePath, 'utf8');
  const ini      = parseINI(text);

  // ── Device info ────────────────────────────────────────────────────────────
  const fi = ini['FileInfo']   || {};
  const di = ini['DeviceInfo'] || {};
  const deviceInfo = {
    fileName:    fi.FileName    || path.basename(filePath),
    fileVersion: fi.FileVersion || '1',
    description: fi.Description || '',
    vendorName:  di.VendorName  || '',
    productName: di.ProductName || '',
    productCode: toNum(di.ProductCode  || '0'),
    revisionNum: toNum(di.RevisionNumber || '0'),
    orderCode:   di.OrderCode   || '',
    nodeId:      toNum(di.NodeId || '0'),
    baudRates:   [], // will fill from DeviceInfo flags
  };

  // ── Build Object Dictionary ────────────────────────────────────────────────
  const od = {};
  for (const [sectionName, sectionData] of Object.entries(ini)) {
    const odMatch  = OD_RE.exec(sectionName);
    const subMatch = SUBIDX_RE.exec(sectionName);

    if (odMatch) {
      const index = parseInt(odMatch[1], 16);
      if (!od[index]) od[index] = {};
      const entry = parseODEntry(sectionData);
      // For VAR (0x07): put in subIndex 0
      if (entry.objectType === 0x07) {
        od[index][0] = { value: entry.value, _raw: sectionData.DefaultValue || '', name: entry.name, dataType: entry.dataType, access: entry.access, pdo: entry.pdo, scaleFactor: entry.scaleFactor, offset: entry.offset };
      } else {
        // ARRAY/RECORD: store metadata at key '_meta', subindexes filled below
        od[index]._meta = entry;
      }
    } else if (subMatch) {
      const index    = parseInt(subMatch[1], 16);
      const subIndex = parseInt(subMatch[2], 16);
      if (!od[index]) od[index] = {};
      const entry = parseODEntry(sectionData);
      od[index][subIndex] = { value: entry.value, _raw: sectionData.DefaultValue || '', name: entry.name, dataType: entry.dataType, access: entry.access, pdo: entry.pdo, scaleFactor: entry.scaleFactor, offset: entry.offset };
    }
  }

  // ── Resolve nodeId for $NODEID expressions ───────────────────────────────
  const nodeIdVal = nodeId || deviceInfo.nodeId || 0;

  // ── Extract TPDO maps (0x1800–0x19FF comm, 0x1A00–0x1BFF mapping) ─────────
  const tpdoMaps = {};
  for (let n = 0; n < 8; n++) {
    const commIdx = 0x1800 + n;
    const mapIdx  = 0x1A00 + n;

    if (!od[commIdx] || !od[mapIdx]) continue;

    const rawCobIdVal = od[commIdx][1] && od[commIdx][1]._raw;
    const rawCobId   = rawCobIdVal ? toNum(rawCobIdVal, nodeIdVal) : ((od[commIdx][1] && od[commIdx][1].value) || 0);
    const cobId      = rawCobId & 0x1FFFFFFF;   // strip valid/RTR bits
    const txType     = (od[commIdx][2] && od[commIdx][2].value) || 0xFF;
    const numMapped  = (od[mapIdx][0]  && od[mapIdx][0].value)  || 0;

    const signals = [];
    let bitOffset = 0;

    for (let s = 1; s <= numMapped; s++) {
      const mapEntry = od[mapIdx][s];
      if (!mapEntry) continue;
      const raw         = mapEntry.value >>> 0;
      const sigIndex    = (raw >>> 16) & 0xFFFF;
      const sigSubIndex = (raw >>>  8) & 0xFF;
      const sigBits     = raw & 0xFF;
      if (sigIndex >= 0x0001 && sigIndex <= 0x0007) { bitOffset += sigBits; continue; }

      // Look up signal name and type in OD
      const sigODEntry = od[sigIndex] && od[sigIndex][sigSubIndex];
      const sigName    = sigODEntry ? sigODEntry.name.replace(/\s+/g, '_') : `Obj_${sigIndex.toString(16).toUpperCase()}_${sigSubIndex}`;
      const dataType   = sigODEntry ? sigODEntry.dataType : 0x0007;
      const typeInfo   = DATA_TYPES[dataType] || { bitLength: sigBits, signed: false };

      signals.push({
        name:      sigName,
        index:     sigIndex,
        subIndex:  sigSubIndex,
        bitOffset: bitOffset,
        bitLength: sigBits || typeInfo.bitLength,
        scale:     sigODEntry ? (sigODEntry.scaleFactor || 1) : 1,
        offset:    sigODEntry ? (sigODEntry.offset      || 0) : 0,
        signed:    typeInfo.signed,
      });
      bitOffset += (sigBits || typeInfo.bitLength);
    }

    tpdoMaps[n + 1] = { cobId, transmitType: txType, signals };
  }

  // ── Extract RPDO maps (0x1400–0x15FF comm, 0x1600–0x17FF mapping) ─────────
  const rpdoMaps = {};
  for (let n = 0; n < 8; n++) {
    const commIdx = 0x1400 + n;
    const mapIdx  = 0x1600 + n;
    if (!od[commIdx] || !od[mapIdx]) continue;

    const rawCobIdRVal = od[commIdx][1] && od[commIdx][1]._raw;
    const rawCobId  = rawCobIdRVal ? toNum(rawCobIdRVal, nodeIdVal) : ((od[commIdx][1] && od[commIdx][1].value) || 0);
    const cobId     = rawCobId & 0x1FFFFFFF;
    const numMapped = (od[mapIdx][0]  && od[mapIdx][0].value)  || 0;

    const signals = [];
    let bitOffset = 0;

    for (let s = 1; s <= numMapped; s++) {
      const mapEntry = od[mapIdx][s];
      if (!mapEntry) continue;
      const raw         = mapEntry.value >>> 0;
      const sigIndex    = (raw >>> 16) & 0xFFFF;
      const sigSubIndex = (raw >>>  8) & 0xFF;
      const sigBits     = raw & 0xFF;
      if (sigIndex >= 0x0001 && sigIndex <= 0x0007) { bitOffset += sigBits; continue; }  // dummy padding
      const sigODEntry  = od[sigIndex] && od[sigIndex][sigSubIndex];
      const sigName     = sigODEntry ? sigODEntry.name.replace(/\s+/g, '_') : `Obj_${sigIndex.toString(16).toUpperCase()}_${sigSubIndex}`;
      const dataType    = sigODEntry ? sigODEntry.dataType : 0x0007;
      const typeInfo    = DATA_TYPES[dataType] || { bitLength: sigBits, signed: false };

      signals.push({
        name:      sigName,
        index:     sigIndex,
        subIndex:  sigSubIndex,
        bitOffset: bitOffset,
        bitLength: sigBits || typeInfo.bitLength,
        scale:     sigODEntry ? (sigODEntry.scaleFactor || 1) : 1,
        offset:    sigODEntry ? (sigODEntry.offset      || 0) : 0,
        signed:    typeInfo.signed,
      });
      bitOffset += (sigBits || typeInfo.bitLength);
    }

    rpdoMaps[n + 1] = { cobId, signals };
  }

  // Remove internal _meta keys from od before returning
  for (const idx of Object.keys(od)) {
    delete od[idx]._meta;
  }

  return { deviceInfo, od, tpdoMaps, rpdoMaps };
}

// ─────────────────────────────────────────────────────────────────────────────
// loadEDSIntoNode(node, eds)
// Merges EDS-derived OD into a live CANopenNode instance.
// Only overwrites entries where the EDS defines a value — node's runtime
// entries (e.g. OD updated by PDO receive) are NOT disturbed.
// ─────────────────────────────────────────────────────────────────────────────
function loadEDSIntoNode(node, eds) {
  for (const [indexStr, subMap] of Object.entries(eds.od)) {
    const index = parseInt(indexStr, 10);
    if (!node.od[index]) node.od[index] = {};
    for (const [subStr, entry] of Object.entries(subMap)) {
      const sub = parseInt(subStr, 10);
      if (node.od[index][sub] === undefined) {
        node.od[index][sub] = { value: entry.value, name: entry.name };
      }
    }
  }

  // Auto-register RPDOs from EDS
  for (const [numStr, rpdo] of Object.entries(eds.rpdoMaps)) {
    if (rpdo.cobId && rpdo.cobId !== 0x80000000) {
      node.registerRPDO(parseInt(numStr, 10), rpdo.cobId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSimulatorPDOMaps(eds, nodeId)
// Returns a PDO_MAPS fragment for canopen_simulator.js.
// The key format matches: `${nodeId}_TPDO${n}`
// ─────────────────────────────────────────────────────────────────────────────
function buildSimulatorPDOMaps(eds, nodeId) {
  const maps = {};
  for (const [numStr, tpdo] of Object.entries(eds.tpdoMaps)) {
    if (!tpdo.signals.length) continue;
    const key = `${nodeId}_TPDO${numStr}`;
    maps[key] = tpdo.signals.map(s => ({
      name:      s.name,
      bitOffset: s.bitOffset,
      bitLength: s.bitLength,
      scale:     s.scale  || 1,
      offset:    s.offset || 0,
      signed:    s.signed || false,
    }));
  }
  return maps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: printEDSSummary(eds)
// ─────────────────────────────────────────────────────────────────────────────
function printEDSSummary(eds) {
  const { deviceInfo, tpdoMaps, rpdoMaps, od } = eds;
  console.log(`\n── EDS: ${deviceInfo.fileName} ───────────────────────────────`);
  console.log(`   Product  : ${deviceInfo.productName} (${deviceInfo.vendorName})`);
  console.log(`   OD size  : ${Object.keys(od).length} objects`);

  for (const [n, tpdo] of Object.entries(tpdoMaps)) {
    console.log(`   TPDO${n}  COB-ID 0x${tpdo.cobId.toString(16).toUpperCase().padStart(3,'0')}  txType:${tpdo.transmitType}  signals: ${tpdo.signals.map(s => s.name).join(', ')}`);
  }
  for (const [n, rpdo] of Object.entries(rpdoMaps)) {
    console.log(`   RPDO${n}  COB-ID 0x${rpdo.cobId.toString(16).toUpperCase().padStart(3,'0')}  signals: ${rpdo.signals.map(s => s.name).join(', ')}`);
  }
}

module.exports = { parseEDS, loadEDSIntoNode, buildSimulatorPDOMaps, printEDSSummary, DATA_TYPES };
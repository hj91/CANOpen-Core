'use strict';
/**
 * canopen_eds.js  v2
 * ─────────────────────────────────────────────────────────────────────────────
 * CiA 306 EDS (Electronic Data Sheet) file parser.
 */

const fs   = require('fs');
const path = require('path');

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
      const val = line.slice(eq + 1).trim().split(';')[0].trim();
      sections[current][key] = val;
    }
  }
  return sections;
}

/**
 * Parse a numeric string, including $NODEID+0x... expressions (CiA 301 §7).
 * Forgiving parser: handles standard 0x prefixes and non-standard 'h' suffixes.
 */
function toNum(s, nodeId) {
  if (!s || s === '') return 0;
  s = s.trim();

  if (s.includes('$NODEID')) {
    const id = nodeId || 0;
    const expr = s.replace(/\$NODEID/g, id.toString(10));
    try {
      const cleanExpr = expr.replace(/\s+/g, '');
      const parts = cleanExpr.split('+');
      return parts.reduce((acc, p) => {
        if (p.startsWith('0x') || p.startsWith('0X')) return acc + parseInt(p, 16);
        if (p.endsWith('h') || p.endsWith('H')) return acc + parseInt(p.slice(0, -1), 16);
        const n = parseInt(p, 10);
        return acc + (isNaN(n) ? 0 : n);
      }, 0);
    } catch { return id; }
  }

  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
  if (s.endsWith('h') || s.endsWith('H')) return parseInt(s.slice(0, -1), 16);
  return parseInt(s, 10);
}

const OD_RE      = /^([0-9A-Fa-f]{4})$/;
const SUBIDX_RE  = /^([0-9A-Fa-f]{4})sub([0-9A-Fa-f]+)$/i;

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

function parseEDS(filePath, nodeId) {
  const text     = fs.readFileSync(filePath, 'utf8');
  const ini      = parseINI(text);

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
    baudRates:   [],
  };

  const od = {};
  for (const [sectionName, sectionData] of Object.entries(ini)) {
    const odMatch  = OD_RE.exec(sectionName);
    const subMatch = SUBIDX_RE.exec(sectionName);

    if (odMatch) {
      const index = parseInt(odMatch[1], 16);
      if (!od[index]) od[index] = {};
      const entry = parseODEntry(sectionData);
      if (entry.objectType === 0x07) {
        od[index][0] = { value: entry.value, _raw: sectionData.DefaultValue || '', name: entry.name, dataType: entry.dataType, access: entry.access, pdo: entry.pdo, scaleFactor: entry.scaleFactor, offset: entry.offset };
      } else {
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

  const nodeIdVal = nodeId || deviceInfo.nodeId || 0;

  const tpdoMaps = {};
  for (let n = 0; n < 8; n++) {
    const commIdx = 0x1800 + n;
    const mapIdx  = 0x1A00 + n;

    if (!od[commIdx] || !od[mapIdx]) continue;

    const rawCobIdVal = od[commIdx][1] && od[commIdx][1]._raw;
    const rawCobId   = rawCobIdVal ? toNum(rawCobIdVal, nodeIdVal) : ((od[commIdx][1] && od[commIdx][1].value) || 0);
    const cobId      = rawCobId & 0x1FFFFFFF;
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
      if (sigIndex >= 0x0001 && sigIndex <= 0x0007) { bitOffset += sigBits; continue; }
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

  for (const idx of Object.keys(od)) {
    delete od[idx]._meta;
  }

  return { deviceInfo, od, tpdoMaps, rpdoMaps };
}

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

  for (const [numStr, rpdo] of Object.entries(eds.rpdoMaps)) {
    if (rpdo.cobId && rpdo.cobId !== 0x80000000) {
      node.registerRPDO(parseInt(numStr, 10), rpdo.cobId);
    }
  }
}

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

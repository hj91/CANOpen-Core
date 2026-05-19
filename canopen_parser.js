'use strict';

/**
 * Bufferstack.IO CANOpen Core - A robust Node.js CANopen library with dynamic EDS parsing,
 * CiA 402 support, and bulletproof physical layer reconnects
 * Copyright (c) 2026 Bufferstack.IO Analytics Technology LLP
 * Copyright (c) 2026 Harshad Joshi
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * CANopen Parser for Node.js
 * Parses raw CAN frames into structured CANopen messages
 * Covers: NMT, SDO, PDO, EMCY, HEARTBEAT, SYNC, TIME
 */

// ─── Function Code Map (upper 4 bits of 11-bit CAN ID) ───────────────────────
const FUNCTION_CODES = {
  0x0: 'NMT',
  0x1: 'SYNC_TIME',   // 0x080 SYNC or TIME
  0x2: 'TIME',
  0x3: 'TPDO1',
  0x4: 'RPDO1',
  0x5: 'TPDO2',
  0x6: 'RPDO2',
  0x7: 'TPDO3',
  0x8: 'RPDO3',
  0x9: 'TPDO4',
  0xA: 'RPDO4',
  0xB: 'SDO_TX',      // Server → Client (response)
  0xC: 'SDO_RX',      // Client → Server (request)
  0xE: 'HEARTBEAT',
};

// ─── NMT Command Specifiers ───────────────────────────────────────────────────
const NMT_COMMANDS = {
  0x01: 'START_REMOTE_NODE',
  0x02: 'STOP_REMOTE_NODE',
  0x80: 'ENTER_PRE_OPERATIONAL',
  0x81: 'RESET_NODE',
  0x82: 'RESET_COMMUNICATION',
};

// ─── NMT Node States (Heartbeat) ─────────────────────────────────────────────
const NMT_STATES = {
  0x00: 'BOOT_UP',
  0x04: 'STOPPED',
  0x05: 'OPERATIONAL',
  0x7F: 'PRE_OPERATIONAL',
};

// ─── SDO Command Specifiers ───────────────────────────────────────────────────
const SDO_CS = {
  // Client → Server (SDO_RX / 0x600)
  0x40: { type: 'UPLOAD_REQUEST',    bytes: 0 },  // read request
  0x20: { type: 'DOWNLOAD_REQUEST',  bytes: 0 },  // write, size unspecified
  0x2F: { type: 'DOWNLOAD_REQUEST',  bytes: 1 },
  0x2B: { type: 'DOWNLOAD_REQUEST',  bytes: 2 },
  0x27: { type: 'DOWNLOAD_REQUEST',  bytes: 3 },
  0x23: { type: 'DOWNLOAD_REQUEST',  bytes: 4 },

  // Server → Client (SDO_TX / 0x580)
  0x60: { type: 'DOWNLOAD_RESPONSE', bytes: 0 },  // write ack
  0x4F: { type: 'UPLOAD_RESPONSE',   bytes: 1 },
  0x4B: { type: 'UPLOAD_RESPONSE',   bytes: 2 },
  0x47: { type: 'UPLOAD_RESPONSE',   bytes: 3 },
  0x43: { type: 'UPLOAD_RESPONSE',   bytes: 4 },
  0x80: { type: 'ABORT',             bytes: 4 },
};

// ─── SDO Abort Codes ──────────────────────────────────────────────────────────
const SDO_ABORT_CODES = {
  0x05030000: 'Toggle bit not alternated',
  0x05040000: 'SDO protocol timed out',
  0x05040001: 'Command specifier invalid',
  0x06010000: 'Unsupported access to object',
  0x06010001: 'Read: write-only object',
  0x06010002: 'Write: read-only object',
  0x06020000: 'Object does not exist in OD',
  0x06040041: 'Object cannot be mapped to PDO',
  0x06090011: 'Subindex does not exist',
  0x06090030: 'Value range exceeded',
  0x08000000: 'General error',
  0x08000020: 'Data cannot be stored',
};

// ─── Core: Decode CAN ID → Function Code + Node ID ───────────────────────────
function decodeCanId(canId) {
  const funcCode = (canId >> 7) & 0x0F;
  const nodeId   = canId & 0x7F;
  return {
    canId,
    funcCode,
    nodeId,
    msgType: FUNCTION_CODES[funcCode] || `UNKNOWN_FC(${funcCode.toString(16).toUpperCase()})`,
  };
}

// ─── NMT Parser ──────────────────────────────────────────────────────────────
function parseNMT(data) {
  if (data.length < 2) return { error: 'NMT frame too short' };
  const cs     = data[0];
  const nodeId = data[1];
  return {
    command: NMT_COMMANDS[cs] || `UNKNOWN_CMD(0x${cs.toString(16).toUpperCase()})`,
    targetNodeId: nodeId === 0 ? 'ALL' : nodeId,
  };
}

// ─── SDO Parser ──────────────────────────────────────────────────────────────
function parseSDO(data, direction) {
  if (data.length < 4) return { error: 'SDO frame too short' };

  const cs       = data[0];
  const index    = data.readUInt16LE(1);
  const subIndex = data[3];
  const csInfo   = SDO_CS[cs];

  const result = {
    direction,    // 'TX' = server response, 'RX' = client request
    commandByte:  `0x${cs.toString(16).toUpperCase().padStart(2, '0')}`,
    type:         csInfo ? csInfo.type : `UNKNOWN_CS(0x${cs.toString(16).toUpperCase()})`,
    index:        `0x${index.toString(16).toUpperCase().padStart(4, '0')}`,
    subIndex,
  };

  if (csInfo && csInfo.bytes > 0 && data.length >= 8) {
    const rawData = data.slice(4, 4 + csInfo.bytes);
    result.rawData  = rawData;
    result.valueU32 = data.readUInt32LE(4);   // interpret as unsigned 32-bit
    result.valueI32 = data.readInt32LE(4);    // interpret as signed 32-bit
  }

  if (cs === 0x80 && data.length >= 8) {
    const abortCode = data.readUInt32LE(4);
    result.abortCode = `0x${abortCode.toString(16).toUpperCase().padStart(8, '0')}`;
    result.abortReason = SDO_ABORT_CODES[abortCode] || 'Unknown abort';
  }

  return result;
}

// ─── PDO Parser (generic — content depends on EDS mapping) ───────────────────
function parsePDO(canId, data) {
  const funcCode = (canId >> 7) & 0x0F;
  const pdoNum   = Math.floor((funcCode - 3) / 2) + 1;   // 1..4
  const dir      = funcCode % 2 === 1 ? 'TPDO' : 'RPDO'; // odd=T, even=R
  return {
    pdoName:   `${dir}${pdoNum}`,
    dlc:       data.length,
    rawBytes:  Array.from(data).map(b => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`),
  };
}

// ─── Heartbeat / Node Guarding Parser ────────────────────────────────────────
function parseHeartbeat(data) {
  if (data.length < 1) return { error: 'Heartbeat frame too short' };
  const stateRaw = data[0] & 0x7F;
  return {
    state: NMT_STATES[stateRaw] || `UNKNOWN_STATE(0x${stateRaw.toString(16).toUpperCase()})`,
  };
}

// ─── EMCY Parser ─────────────────────────────────────────────────────────────
function parseEMCY(data) {
  if (data.length < 3) return { error: 'EMCY frame too short' };
  return {
    errorCode:     `0x${data.readUInt16LE(0).toString(16).toUpperCase().padStart(4, '0')}`,
    errorRegister: `0x${data[2].toString(16).toUpperCase().padStart(2, '0')}`,
    mfgErrorField: data.length >= 8
      ? Array.from(data.slice(3)).map(b => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`)
      : [],
  };
}

// ─── SYNC / TIME Parser ───────────────────────────────────────────────────────
function parseSYNC_TIME(canId, data) {
  if (canId === 0x080) {
    return { subType: 'SYNC', counter: data.length > 0 ? data[0] : null };
  }
  if (canId === 0x100 && data.length >= 6) {
    const ms    = data.readUInt32LE(0);
    const days  = data.readUInt16LE(4);
    return { subType: 'TIME', milliseconds: ms, days };
  }
  return { subType: 'UNKNOWN', rawData: Array.from(data) };
}

// ─── Main Entry: parseFrame() ─────────────────────────────────────────────────
function parseFrame(canId, data) {
  const header  = decodeCanId(canId);
  const base    = { ...header, timestamp: Date.now() };

  switch (header.msgType) {
    case 'NMT':
      return { ...base, payload: parseNMT(data) };

    case 'SYNC_TIME':
      if (header.nodeId === 0)
        return { ...base, payload: parseSYNC_TIME(canId, data) };
      // nodeId > 0 in the SYNC/EMCY range = EMCY message
      return { ...base, msgType: 'EMCY', payload: parseEMCY(data) };

    case 'SDO_TX':
      return { ...base, payload: parseSDO(data, 'TX') };

    case 'SDO_RX':
      return { ...base, payload: parseSDO(data, 'RX') };

    case 'TPDO1': case 'RPDO1':
    case 'TPDO2': case 'RPDO2':
    case 'TPDO3': case 'RPDO3':
    case 'TPDO4': case 'RPDO4':
      return { ...base, payload: parsePDO(canId, data) };

    case 'HEARTBEAT':
      return { ...base, payload: parseHeartbeat(data) };

    default:
      if (canId === 0x080) // EMCY uses 0x080+nodeId
        return { ...base, msgType: 'EMCY', payload: parseEMCY(data) };
      return { ...base, payload: { raw: Array.from(data) } };
  }
}

// ─── PDO Signal Mapper (EDS-driven) ──────────────────────────────────────────
function mapPDOSignals(data, mapping) {
  const result = {};
  const buf    = Buffer.isBuffer(data) ? data : Buffer.from(data);

  for (const sig of mapping) {
    const byteStart = Math.floor(sig.bitOffset / 8);
    const byteLen   = Math.ceil(sig.bitLength / 8);
    const raw       = buf.readUIntLE(byteStart, Math.min(byteLen, 6));
    const value     = (sig.signed && raw & (1 << (sig.bitLength - 1)))
                        ? raw - (1 << sig.bitLength)   // sign extend
                        : raw;
    result[sig.name] = value * (sig.scale || 1) + (sig.offset || 0);
  }
  return result;
}

module.exports = { parseFrame, mapPDOSignals, decodeCanId };

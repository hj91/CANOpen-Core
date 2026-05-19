'use strict';
/**
 * canopen_node.js v6 (Industrial Motion & LSS Edition - Patched)
 * Full CiA 301 base node + CiA 305 LSS Master + CiA 402 Motion profiles.
 * Includes Segmented SDO client (Upload & Download) and Active SYNC Production.
 */

const NMT_STATES  = { INITIALIZING: 0, PRE_OPERATIONAL: 127, OPERATIONAL: 5, STOPPED: 4 };

const NODE_STATUS = {
    INITIALIZING : 'INITIALIZING',
    OPERATIONAL  : 'OPERATIONAL',
    PRE_OPERATIONAL: 'PRE_OPERATIONAL',
    FAULT        : 'FAULT',
    OFFLINE      : 'OFFLINE',
};

const CIA402_STATES = {
    0x00: 'NOT_READY',          
    0x40: 'SWITCH_ON_DISABLED',
    0x21: 'READY_TO_SWITCH_ON', 
    0x23: 'SWITCHED_ON',
    0x27: 'OPERATION_ENABLED',  
    0x07: 'QUICK_STOP_ACTIVE',
    0x0F: 'FAULT_REACTION_ACTIVE', 
    0x08: 'FAULT',
};

const CIA402_MODES = {
    1: 'Profile Position (PP)',
    3: 'Profile Velocity (PV)',
    4: 'Profile Torque (PT)',
    6: 'Homing (HM)',
    8: 'Cyclic Synchronous Position (CSP)',
    9: 'Cyclic Synchronous Velocity (CSV)',
    10: 'Cyclic Synchronous Torque (CST)'
};

function decodeCIA402State(statusWord) {
    const masked = statusWord & 0x006F;
    return CIA402_STATES[masked] || `UNKNOWN(0x${masked.toString(16).toUpperCase()})`;
}

class CANopenNode {
    constructor({ bus, nodeId, deviceName, heartbeatMs = 1000, config = {} }) {
        this.bus        = bus;
        this.nodeId     = nodeId;
        this.deviceName = deviceName;
        this.nmtState   = NMT_STATES.INITIALIZING;
        this.heartbeatMs = heartbeatMs;
        this._timers    = [];
        this._config    = config;

        this._nodeStatus  = NODE_STATUS.INITIALIZING;
        this._faultCode   = null;
        this._heartbeatTimer = null;
        this._onStatusChange = null;

        this._sdoQueues   = new Map(); 
        this._pendingSDO  = new Map();
        this._segTx       = null;   // SDO server segmented upload state
        this._rpdoCobIds  = new Map();
        this._errorHistory = [];
        this._syncTimer   = null;
        this._syncCounter = 0;
        this._tpdoMaps    = new Map();

        // ─── Default Object Dictionary (CiA 301 compliant) ───────────────────
        this.od = {
            0x1000: { 0: { value: 0x00000000, name: 'DeviceType' } },
            0x1001: { 0: { value: 0x00,       name: 'ErrorRegister' } },
            0x1003: { 0: { value: 0,           name: 'NumberOfErrors' } },
            0x1005: { 0: { value: 0x00000080,  name: 'COB_ID_SYNC' } },
            0x1006: { 0: { value: 0,           name: 'CommCyclePeriod' } },
            0x1008: { 0: { value: deviceName,  name: 'ManufacturerDeviceName' } },
            0x100A: { 0: { value: '6.0.0',     name: 'ManufacturerSoftwareVersion' } },
            0x1014: { 0: { value: 0x00000080 + nodeId, name: 'COB_ID_EMCY' } },
            0x1016: {
                0: { value: 1, name: 'HighestSubIndex' },
                1: { value: (nodeId << 16) | (config.heartbeat_timeout_ms || 5000), name: 'ConsumerHeartbeatTime_1' },
            },
            0x1017: { 0: { value: heartbeatMs, name: 'ProducerHeartbeatTime' } },
            0x1018: {
                0: { value: 4,          name: 'HighestSubIndex' },
                1: { value: 0x00000000, name: 'VendorId' },
                2: { value: 0x00000000, name: 'ProductCode' },
                3: { value: 0x00000000, name: 'RevisionNumber' },
                4: { value: 0x00000000, name: 'SerialNumber' },
            },
            0x1019: { 0: { value: 0, name: 'SyncCounterOverflow' } },
            0x1020: {
                0: { value: 2,          name: 'HighestSubIndex' },
                1: { value: 0x00000000, name: 'VerifyConfigDate' },
                2: { value: 0x00000000, name: 'VerifyConfigTime' },
            },
        };

        bus.onFrame(frame => this._onFrame(frame));
    }

    // ─── Dynamic TPDO Engine ──────────────────────────────────────────────────
    addTPDOMap(cobId, signals) {
        let offset = 0;
        const mapped = [];
        for (const sig of signals) {
            let bytes   = 4;
            let isSigned = false;
            const dt = sig.dataType || 0x0007;

            if ([0x0001, 0x0002, 0x0005].includes(dt)) bytes = 1;
            else if ([0x0003, 0x0006].includes(dt))     bytes = 2;
            else if ([0x0004, 0x0007, 0x0008].includes(dt)) bytes = 4;

            if ([0x0002, 0x0003, 0x0004].includes(dt)) isSigned = true;

            mapped.push({ index: sig.index, subIndex: sig.subIndex, offset, bytes, isSigned });
            offset += bytes;
        }
        this._tpdoMaps.set(cobId, mapped);
    }

    // ─── NMT State Machine ────────────────────────────────────────────────────
    start() {
        this._sendBootup();
        this._setState(NMT_STATES.PRE_OPERATIONAL);
        this._setNodeStatus(NODE_STATUS.PRE_OPERATIONAL);

        if (this._config.bootUpSelfStart) {
            this._setState(NMT_STATES.OPERATIONAL);
            this._setNodeStatus(NODE_STATUS.OPERATIONAL);
            this._startHeartbeat();
            this._resetHeartbeatWatchdog();
            this.startSyncProducer();
            this.onOperational();
        } else {
            this._startHeartbeat();
            this._resetHeartbeatWatchdog();
        }
    }

    _setState(s) { this.nmtState = s; }
    _sendBootup() { this.bus.send(0x700 + this.nodeId, [0x00]); }

    // ─── Heartbeat Logic ──────────────────────────────────────────────────────
    _startHeartbeat() {
        const t = setInterval(() => {
            this.bus.send(0x700 + this.nodeId, [this.nmtState]);
        }, this.heartbeatMs);
        this._timers.push(t);
    }

    _resetHeartbeatWatchdog() {
        clearTimeout(this._heartbeatTimer);
        const hb1 = this.od[0x1016] && this.od[0x1016][1] ? this.od[0x1016][1].value : 0;
        const ms  = (hb1 & 0xFFFF) || this._config.heartbeat_timeout_ms || 5000;
        
        this._heartbeatTimer = setTimeout(() => {
            this._setNodeStatus(NODE_STATUS.OFFLINE);
            console.error(`[NODE ${this.nodeId}] Heartbeat timeout — OFFLINE (no HB for ${ms}ms)`);
            
            if (this._config.autoResetOnHeartbeatLoss) {
                this.bus.send(0x000, [0x81, this.nodeId]);
            } else {
                console.warn(`[CANopen] Heartbeat lost for node ${this.nodeId}. Auto-reset disabled.`);
            }
        }, ms);
    }

    _setNodeStatus(status, faultCode = null) {
        const changed = this._nodeStatus !== status || this._faultCode !== faultCode;
        this._nodeStatus = status;
        this._faultCode  = faultCode;
        if (changed && this._onStatusChange) this._onStatusChange(this.nodeId, status, faultCode);
    }

    getStatus() {
        return { nodeId: this.nodeId, status: this._nodeStatus, faultCode: this._faultCode };
    }

    // ─── SYNC Producer ────────────────────────────────────────────────────────
    startSyncProducer(intervalMs) {
        this.stopSyncProducer();
        
        if (intervalMs !== undefined && intervalMs > 0) {
            if (!this.od[0x1006]) this.od[0x1006] = { 0: { name: 'CommCyclePeriod', value: 0 } };
            this.od[0x1006][0].value = intervalMs * 1000; 
        }

        const periodUs = this.od[0x1006] && this.od[0x1006][0] ? this.od[0x1006][0].value : 0;
        if (periodUs <= 0) return; 

        const cobId   = (this.od[0x1005] && this.od[0x1005][0] ? this.od[0x1005][0].value : 0x80) & 0x1FFFFFFF;
        const overflow = this.od[0x1019] && this.od[0x1019][0] ? this.od[0x1019][0].value : 0;
        const periodMs = Math.max(1, Math.round(periodUs / 1000));
        
        this._syncCounter = 0;
        const t = setInterval(() => {
            if (this._nodeStatus !== NODE_STATUS.OPERATIONAL) return;
            if (overflow > 1) {
                this._syncCounter = (this._syncCounter % overflow) + 1;
                this.od[0x1019][0].value = overflow;
                this.bus.send(cobId, [this._syncCounter]);
            } else {
                this.bus.send(cobId, []);
            }
        }, periodMs);
        
        this._syncTimer = t;
        this._timers.push(t);
    }

    stopSyncProducer() {
        if (this._syncTimer) {
            clearInterval(this._syncTimer);
            this._syncTimer = null;
        }
    }

    // ─── LSS Master Engine (CiA 305) ──────────────────────────────────────────
    sendLSSSwitchModeGlobal(mode) {
        this.bus.send(0x7E5, [0x04, mode & 0x01, 0, 0, 0, 0, 0, 0]);
    }

    sendLSSConfigureNodeId(newNodeId) {
        this.bus.send(0x7E5, [0x11, newNodeId & 0x7F, 0, 0, 0, 0, 0, 0]);
    }

    // ─── SDO Server ───────────────────────────────────────────────────────────
    _handleSDO(data) {
        const cs       = data[0];
        const index    = data.readUInt16LE(1);
        const subIndex = data[3];

        if (cs === 0x40) {
            const entry = this.od[index] && this.od[index][subIndex];
            if (!entry) return this._sdoAbort(index, subIndex, 0x06020000);

            const val  = entry.value;
            const resp = Buffer.alloc(8, 0);
            resp[1] = index & 0xFF; resp[2] = (index >> 8) & 0xFF; resp[3] = subIndex;

            if (typeof val === 'number') {
                resp[0] = 0x43; resp.writeInt32LE(val, 4);
                return this.bus.send(0x580 + this.nodeId, resp);
            }
            if (typeof val === 'string') {
                const strBuf = Buffer.from(val, 'utf8');
                if (strBuf.length <= 4) {
                    resp[0] = 0x43 | ((4 - strBuf.length) << 2) | 0x01;
                    strBuf.copy(resp, 4);
                    return this.bus.send(0x580 + this.nodeId, resp);
                }
                resp[0] = 0x41; resp.writeUInt32LE(strBuf.length, 4);
                this._segTx = { index, subIndex, data: strBuf, offset: 0, toggle: 0 };
                return this.bus.send(0x580 + this.nodeId, resp);
            }
        }

        if ((cs & 0xE1) === 0x60 && this._segTx) {
            const toggle = (cs >> 4) & 0x01;
            if (toggle !== this._segTx.toggle)
                return this._sdoAbort(this._segTx.index, this._segTx.subIndex, 0x05030000);
            const seg   = this._segTx;
            const chunk = seg.data.slice(seg.offset, seg.offset + 7);
            const last  = (seg.offset + 7) >= seg.data.length;
            const resp  = Buffer.alloc(8, 0);
            resp[0] = (toggle << 4) | ((7 - chunk.length) << 1) | (last ? 0x01 : 0x00);
            chunk.copy(resp, 1);
            this.bus.send(0x580 + this.nodeId, resp);
            seg.offset += 7; seg.toggle ^= 1;
            if (last) this._segTx = null;
            return;
        }

        if ((cs & 0xE0) === 0x20) {
            const bytes = [4, 3, 2, 1][(cs >> 2) & 0x3] || 4;
            const entry = this.od[index] && this.od[index][subIndex];
            if (!entry) return this._sdoAbort(index, subIndex, 0x06020000);
            entry.value = data.readIntLE(4, Math.min(bytes, 6));
            const resp  = Buffer.alloc(8, 0);
            resp[0] = 0x60; resp[1] = index & 0xFF; resp[2] = (index >> 8) & 0xFF; resp[3] = subIndex;
            this.bus.send(0x580 + this.nodeId, resp);
            this.onODWrite(index, subIndex, entry.value);
            return;
        }
    }

    _sdoAbort(index, subIndex, abortCode) {
        const resp = Buffer.alloc(8, 0);
        resp[0] = 0x80; resp[1] = index & 0xFF; resp[2] = (index >> 8) & 0xFF; resp[3] = subIndex;
        resp.writeUInt32LE(abortCode, 4);
        this.bus.send(0x580 + this.nodeId, resp);
    }

    // ─── SDO Client / Queuing ──────────────────────────────────────────────────
    _processSdoQueue(nodeId) {
        if (this._pendingSDO.has(nodeId)) return; 

        const queue = this._sdoQueues.get(nodeId);
        if (!queue || queue.length === 0) return;

        const task = queue.shift();
        
        if (task.type === 'read') {
            this._executeSdoRead(nodeId, task.index, task.subIndex, task.timeoutMs)
                .then(res => { task.resolve(res); this._processSdoQueue(nodeId); })
                .catch(err => { task.reject(err); this._processSdoQueue(nodeId); });
        } else {
            this._executeSdoWrite(nodeId, task.index, task.subIndex, task.value, task.timeoutMs)
                .then(res => { task.resolve(res); this._processSdoQueue(nodeId); })
                .catch(err => { task.reject(err); this._processSdoQueue(nodeId); });
        }
    }

    sdoRead(remoteNodeId, index, subIndex, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (!this._sdoQueues.has(remoteNodeId)) this._sdoQueues.set(remoteNodeId, []);
            this._sdoQueues.get(remoteNodeId).push({ type: 'read', index, subIndex, timeoutMs, resolve, reject });
            this._processSdoQueue(remoteNodeId);
        });
    }

    sdoWrite(remoteNodeId, index, subIndex, value, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (!this._sdoQueues.has(remoteNodeId)) this._sdoQueues.set(remoteNodeId, []);
            this._sdoQueues.get(remoteNodeId).push({ type: 'write', index, subIndex, value, timeoutMs, resolve, reject });
            this._processSdoQueue(remoteNodeId);
        });
    }

    _executeSdoRead(remoteNodeId, index, subIndex, timeoutMs) {
        timeoutMs = timeoutMs || this._config.sdo_timeout_ms || 500;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingSDO.delete(remoteNodeId);
                reject(new Error(`SDO read timeout — node ${remoteNodeId} 0x${index.toString(16).toUpperCase()}[${subIndex}]`));
            }, timeoutMs);
            this._pendingSDO.set(remoteNodeId, { resolve, reject, timer, type: 'read' });
            this.bus.send(0x600 + remoteNodeId, [0x40, index & 0xFF, (index >> 8) & 0xFF, subIndex, 0, 0, 0, 0]);
        });
    }

    _executeSdoWrite(remoteNodeId, index, subIndex, value, timeoutMs) {
        timeoutMs = timeoutMs || this._config.sdo_timeout_ms || 500;
        return new Promise((resolve, reject) => {
            let dataBuf = null;
            if (Buffer.isBuffer(value))       dataBuf = value;
            else if (typeof value === 'string') dataBuf = Buffer.from(value, 'utf8');

            const timer = setTimeout(() => {
                this._pendingSDO.delete(remoteNodeId);
                reject(new Error(`SDO write timeout — node ${remoteNodeId} 0x${index.toString(16).toUpperCase()}[${subIndex}]`));
            }, timeoutMs);

            if (dataBuf && dataBuf.length > 4) {
                // Segmented download
                this._pendingSDO.set(remoteNodeId, {
                    resolve, reject, timer,
                    type: 'write_seg',
                    segData: dataBuf, segOffset: 0, segToggle: 0, segLastSent: false,
                    index, subIndex,
                });
                const init = Buffer.alloc(8, 0);
                init[0] = 0x22;
                init[1] = index & 0xFF; init[2] = (index >> 8) & 0xFF; init[3] = subIndex;
                init.writeUInt32LE(dataBuf.length, 4);
                this.bus.send(0x600 + remoteNodeId, init);
            } else {
                // Expedited download
                this._pendingSDO.set(remoteNodeId, { resolve, reject, timer, type: 'write' });
                const frame = Buffer.alloc(8, 0);
                if (dataBuf) {
                    const n = Math.min(dataBuf.length, 4);
                    frame[0] = 0x23 | ((4 - n) << 2); 
                    frame[1] = index & 0xFF; frame[2] = (index >> 8) & 0xFF; frame[3] = subIndex;
                    dataBuf.copy(frame, 4, 0, n);
                } else {
                    frame[0] = 0x23;
                    frame[1] = index & 0xFF; frame[2] = (index >> 8) & 0xFF; frame[3] = subIndex;
                    
                    // FIXED: Properly handle signed vs unsigned integers
                    if (value !== null && value !== undefined) {
                        if (value < 0) {
                            frame.writeInt32LE(value, 4);
                        } else {
                            frame.writeUInt32LE(value >>> 0, 4);
                        }
                    } else {
                        frame.writeInt32LE(0, 4);
                    }
                }
                this.bus.send(0x600 + remoteNodeId, frame);
            }
        });
    }

    // ─── RPDO / TPDO Helpers ─────────────────────────────────────────────────
    registerRPDO(pdoNum, cobId) {
        if (cobId === undefined) cobId = (pdoNum - 1) * 0x100 + 0x200 + this.nodeId;
        this._rpdoCobIds.set(cobId, pdoNum);
    }

    sendTPDO(pdoNum, data) {
        const canId = (pdoNum * 0x100) + 0x80 + this.nodeId;
        this.bus.send(canId, data);
    }

    // ─── Node Guarding (legacy CiA 301) ──────────────────────────────────────
    sendGuardRequest(remoteNodeId) {
        if (typeof this.bus.sendRTR === 'function') {
            this.bus.sendRTR(0x700 + remoteNodeId);
        }
    }

    // ─── EMCY ────────────────────────────────────────────────────────────────
    sendEMCY(errorCode, errorRegister, mfgField = [0, 0, 0, 0, 0]) {
        const cobIdEmcy = (this.od[0x1014] && this.od[0x1014][0])
            ? (this.od[0x1014][0].value & 0x1FFFFFFF)
            : (0x080 + this.nodeId);
        const frame = Buffer.alloc(8, 0);
        frame.writeUInt16LE(errorCode, 0);
        frame[2] = errorRegister;
        mfgField.slice(0, 5).forEach((b, i) => { frame[3 + i] = b; });
        this.bus.send(cobIdEmcy, frame);
        this.od[0x1001][0].value = errorRegister;
        if (errorCode !== 0x0000) {
            this._errorHistory.unshift(errorCode);
            if (this._errorHistory.length > 5) this._errorHistory.pop();
        } else {
            this._errorHistory = [];
            this.od[0x1001][0].value = 0;
        }
        const hist = { 0: { value: this._errorHistory.length, name: 'NumberOfErrors' } };
        this._errorHistory.forEach((code, i) => { hist[i + 1] = { value: code, name: `Error${i + 1}` }; });
        this.od[0x1003] = hist;
    }

    getErrorHistory() { return [...this._errorHistory]; }

    // ─── NMT Commands ────────────────────────────────────────────────────────
    nmtStart(targetNodeId   = 0) { this.bus.send(0x000, [0x01, targetNodeId]); }
    nmtStop(targetNodeId    = 0) { this.bus.send(0x000, [0x02, targetNodeId]); }
    nmtReset(targetNodeId   = 0) { this.bus.send(0x000, [0x81, targetNodeId]); }
    nmtPreOp(targetNodeId   = 0) { this.bus.send(0x000, [0x80, targetNodeId]); }
    nmtResetComm(targetNodeId = 0) { this.bus.send(0x000, [0x82, targetNodeId]); }

    // ─── Frame Handler ────────────────────────────────────────────────────────
    _onFrame(frame) {
        const { id, data } = frame;

        if (this._tpdoMaps.has(id)) {
            const maps = this._tpdoMaps.get(id);
            maps.forEach(m => {
                if (data.length >= m.offset + m.bytes && m.bytes > 0) {
                    let val = 0;
                    if      (m.bytes === 1) val = m.isSigned ? data.readInt8(m.offset)      : data.readUInt8(m.offset);
                    else if (m.bytes === 2) val = m.isSigned ? data.readInt16LE(m.offset)   : data.readUInt16LE(m.offset);
                    else if (m.bytes === 4) val = m.isSigned ? data.readInt32LE(m.offset)   : data.readUInt32LE(m.offset);
                    if (!this.od[m.index]) this.od[m.index] = {};
                    if (!this.od[m.index][m.subIndex])
                        this.od[m.index][m.subIndex] = { name: `Obj_${m.index.toString(16)}_${m.subIndex}` };
                    this.od[m.index][m.subIndex].value = val;
                }
            });
            this.onTPDO(id, data);
            return;
        }

        if (id === 0x000 && data.length >= 2) {
            const target = data[1];
            if (target === 0 || target === this.nodeId) {
                const cs = data[0];
                if      (cs === 0x01) { this._setState(NMT_STATES.OPERATIONAL);    this._setNodeStatus(NODE_STATUS.OPERATIONAL);    this.startSyncProducer(); }
                else if (cs === 0x02) { this._setState(NMT_STATES.STOPPED);        this._setNodeStatus(NODE_STATUS.OFFLINE);        this.stopSyncProducer(); }
                else if (cs === 0x80) { this._setState(NMT_STATES.PRE_OPERATIONAL);this._setNodeStatus(NODE_STATUS.PRE_OPERATIONAL);this.stopSyncProducer(); }
                else if (cs === 0x81 || cs === 0x82) {
                    this._setState(NMT_STATES.INITIALIZING);
                    this._setNodeStatus(NODE_STATUS.INITIALIZING);
                    this.stopSyncProducer();
                }
            }
            return;
        }

        const syncCobId = (this.od[0x1005] && this.od[0x1005][0])
            ? (this.od[0x1005][0].value & 0x1FFFFFFF) : 0x080;
        if (id === syncCobId && syncCobId !== 0) {
            const counter = (data.length >= 1) ? data[0] : 0;
            this.onSYNC(counter);
            return;
        }

        if (id === 0x100 && data.length >= 6) {
            const ms   = data.readUInt32LE(0);
            const days = data.readUInt16LE(4);
            this.onTIME(ms, days);
            return;
        }

        if (id === 0x600 + this.nodeId && data.length >= 4) {
            this._handleSDO(data);
            return;
        }

        // SDO client (responses from remote nodes)
        if (id >= 0x581 && id <= 0x5FF) {
            const remoteId = id - 0x580;
            const pending  = this._pendingSDO.get(remoteId);
            if (!pending) return;
            const cs = data[0];

            // Abort code always terminates the transfer
            if (cs === 0x80) {
                clearTimeout(pending.timer);
                this._pendingSDO.delete(remoteId);
                const abortCode = data.readUInt32LE(4);
                return pending.reject(new Error(`SDO abort 0x${abortCode.toString(16).toUpperCase().padStart(8, '0')}`));
            }

            if (pending.type === 'read') {
                if (cs === 0x41) {
                    // Segmented Upload Initiated
                    const totalLen = data.readUInt32LE(4);
                    pending.type = 'read_seg';
                    pending.segData = Buffer.alloc(totalLen);
                    pending.segOffset = 0;
                    pending.segToggle = 0;

                    const req = Buffer.alloc(8, 0);
                    req[0] = 0x60; // Request first segment
                    this.bus.send(0x600 + remoteId, req);

                    clearTimeout(pending.timer);
                    pending.timer = setTimeout(() => {
                        this._pendingSDO.delete(remoteId);
                        pending.reject(new Error(`SDO segmented read timeout — node ${remoteId}`));
                    }, this._config.sdo_timeout_ms || 500);
                    return;
                } else if (cs === 0x43 || cs === 0x47 || cs === 0x4B || cs === 0x4F || cs === 0x40) {
                    // Expedited Upload
                    clearTimeout(pending.timer);
                    this._pendingSDO.delete(remoteId);
                    pending.resolve(data.readInt32LE(4));
                    return;
                }
            } else if (pending.type === 'read_seg') {
                if ((cs & 0xE0) === 0x00) { // Segment received
                    const toggle = (cs >> 4) & 0x01;
                    if (toggle !== pending.segToggle) {
                        clearTimeout(pending.timer);
                        this._pendingSDO.delete(remoteId);
                        return pending.reject(new Error('SDO segmented read: toggle bit mismatch'));
                    }

                    const last = (cs & 0x01) !== 0;
                    const noDataBytes = (cs >> 1) & 0x07;
                    const validBytes = 7 - noDataBytes;

                    data.copy(pending.segData, pending.segOffset, 1, 1 + validBytes);
                    pending.segOffset += validBytes;

                    if (last) {
                        clearTimeout(pending.timer);
                        this._pendingSDO.delete(remoteId);
                        return pending.resolve(pending.segData); // Return full Buffer
                    }

                    pending.segToggle ^= 1;
                    const req = Buffer.alloc(8, 0);
                    req[0] = 0x60 | (pending.segToggle << 4);
                    this.bus.send(0x600 + remoteId, req);

                    clearTimeout(pending.timer);
                    pending.timer = setTimeout(() => {
                        this._pendingSDO.delete(remoteId);
                        pending.reject(new Error(`SDO segmented read timeout — node ${remoteId}`));
                    }, this._config.sdo_timeout_ms || 500);
                    return;
                }
            } else if (pending.type === 'write') {
                clearTimeout(pending.timer);
                this._pendingSDO.delete(remoteId);
                pending.resolve();
                return;
            } else if (pending.type === 'write_seg') {
                const isSegAck = (cs & 0xE0) === 0x20;

                if (isSegAck) {
                    const respToggle = (cs >> 4) & 0x01;
                    if (respToggle !== pending.segToggle) {
                        clearTimeout(pending.timer);
                        this._pendingSDO.delete(remoteId);
                        return pending.reject(new Error('SDO segmented write: toggle bit mismatch'));
                    }
                    if (pending.segLastSent) {
                        clearTimeout(pending.timer);
                        this._pendingSDO.delete(remoteId);
                        return pending.resolve();
                    }
                    pending.segToggle ^= 1;
                }

                const chunk = pending.segData.slice(pending.segOffset, pending.segOffset + 7);
                const last  = (pending.segOffset + chunk.length) >= pending.segData.length;
                const segFrame = Buffer.alloc(8, 0);
                segFrame[0] = (pending.segToggle << 4) | ((7 - chunk.length) << 1) | (last ? 0x01 : 0x00);
                chunk.copy(segFrame, 1);
                pending.segOffset  += chunk.length;
                pending.segLastSent = last;

                clearTimeout(pending.timer);
                pending.timer = setTimeout(() => {
                    this._pendingSDO.delete(remoteId);
                    pending.reject(new Error(`SDO segmented write timeout — node ${remoteId}`));
                }, this._config.sdo_timeout_ms || 500);

                this.bus.send(0x600 + remoteId, segFrame);
                return;
            }
        }

        if (id === 0x700 + this.nodeId && data.length >= 1) {
            const raw = data[0] & 0x7F;
            this._resetHeartbeatWatchdog();
            if (raw === 0x00) {
                this._setState(NMT_STATES.INITIALIZING);
                this._setNodeStatus(NODE_STATUS.INITIALIZING);
            } else if (raw === NMT_STATES.OPERATIONAL && this._nodeStatus === NODE_STATUS.OFFLINE) {
                this._setNodeStatus(NODE_STATUS.OPERATIONAL);
                this.onOperational();
            }
            return;
        }

        if (id === 0x080 + this.nodeId && data.length >= 3) {
            const errorCode = data.readUInt16LE(0);
            if (errorCode === 0x0000) {
                this._setNodeStatus(NODE_STATUS.OPERATIONAL);
            } else {
                const code = `0x${errorCode.toString(16).toUpperCase().padStart(4, '0')}`;
                this._setNodeStatus(NODE_STATUS.FAULT, code);
            }
            return;
        }

        if (this._rpdoCobIds.has(id)) {
            this.onRPDO(this._rpdoCobIds.get(id), data);
        }
    }

    // ─── Override hooks ───────────────────────────────────────────────────────
    onOperational() {}
    onRPDO(pdoNum, data) {}
    onTPDO(cobId, data) {}
    onODWrite(index, subIndex, value) {}
    onSYNC(counter) {}
    onTIME(ms, days) {}

    // ─── Teardown ─────────────────────────────────────────────────────────────
    stop() {
        clearTimeout(this._heartbeatTimer);
        this.stopSyncProducer();
        this._timers.forEach(clearInterval);
        this._timers = [];
        this._pendingSDO.forEach(p => { clearTimeout(p.timer); p.reject(new Error('Node stopped')); });
        this._pendingSDO.clear();
        this._sdoQueues.clear();
    }
}

module.exports = { CANopenNode, NMT_STATES, NODE_STATUS, CIA402_STATES, decodeCIA402State, CIA402_MODES };
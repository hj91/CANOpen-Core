/**
 * Bufferstack.IO CANOpen Core - A robust Node.js CANopen library with dynamic EDS parsing,
 * CiA 402 support, and bulletproof physical layer reconnects
 */

'use strict';

const EventEmitter = require('events');
const { createBus } = require('./canopen_bus');
const { CANopenNode, NODE_STATUS } = require('./canopen_node');
const { parseEDS, loadEDSIntoNode } = require('./canopen_eds');

class CanopenDevice extends EventEmitter {
    constructor(options) {
        super();
        this.nodeId = options.nodeId;
        this.options = options;
        
        this.bus = null;
        this.node = null;
        this.eds = null;
        this.tagMap = new Map(); // Maps string names to { index, subIndex }
        
        this.status = 'DISCONNECTED';

        if (options.edsFile) {
            this._loadEds(options.edsFile);
        }
    }

    _loadEds(filePath) {
        this.eds = parseEDS(filePath, this.nodeId);
        
        // Flatten the EDS Object Dictionary into a searchable Name -> Coordinates map
        for (const [idxStr, subMap] of Object.entries(this.eds.od)) {
            for (const [subStr, entry] of Object.entries(subMap)) {
                if (entry.name && entry.access !== 'const') {
                    const safeName = entry.name.replace(/[^a-zA-Z0-9_]/g, '_');
                    
                    let finalName = safeName;
                    let count = 2;
                    while (this.tagMap.has(finalName)) {
                        finalName = `${safeName}_${count}`;
                        count++;
                    }

                    this.tagMap.set(finalName, {
                        index: parseInt(idxStr, 10),
                        subIndex: parseInt(subStr, 10),
                        access: entry.access
                    });
                }
            }
        }
    }

    /**
     * Initializes the connection engine and starts the state machine.
     */
    async connect() {
        if (this.bus) this.disconnect();

        this.bus = createBus({
            canbus: {
                type: this.options.busType,
                interface: this.options.interface,
                comm_port: this.options.commPort,
                tcp_host: this.options.tcpHost,
                tcp_port: this.options.tcpPort,
                baud_rate: this.options.baudRate || 115200
            }
        });

        this.node = new CANopenNode({
            bus: this.bus,
            nodeId: this.nodeId,
            deviceName: `Node_${this.nodeId}`,
            heartbeatMs: Math.floor((this.options.heartbeatMs || 3000) / 3),
            config: { 
                heartbeat_timeout_ms: this.options.heartbeatMs || 3000, 
                sdo_timeout_ms: 500, 
                autoResetOnHeartbeatLoss: this.options.autoResetOnHeartbeatLoss ?? false,
                bootUpSelfStart: true
            }
        });

        if (this.eds) {
            loadEDSIntoNode(this.node, this.eds);
        }

        // Pass-through connection events
        this.bus.on('bus_connected', () => this.emit('connected'));
        this.bus.on('bus_disconnected', () => this.emit('disconnected'));
        this.bus.on('bus_reconnecting', (info) => this.emit('reconnecting', info));
        this.bus.on('bus_error', (err) => this.emit('error', err));

        // State Machine Events
        this.node._onStatusChange = (nodeId, newStatus, faultCode) => {
            this.status = newStatus;
            this.emit('status_change', { status: newStatus, faultCode });
        };

        await this.bus.connect();
        
        if (this.status !== 'OFFLINE') {
            this.node.start();
        }
    }

    disconnect() {
        if (this.node) this.node.stop();
        if (this.bus) this.bus.close();
        this.status = 'DISCONNECTED';
    }

    // ─── NMT Master Commands ──────────────────────────────────────────────────
    nmtStart(targetNodeId = 0) { this.node.nmtStart(targetNodeId); }
    nmtStop(targetNodeId = 0) { this.node.nmtStop(targetNodeId); }
    nmtReset(targetNodeId = 0) { this.node.nmtReset(targetNodeId); }
    nmtPreOp(targetNodeId = 0) { this.node.nmtPreOp(targetNodeId); }
    nmtResetComm(targetNodeId = 0) { this.node.nmtResetComm(targetNodeId); }

    // ─── PDO Data Handling ────────────────────────────────────────────────────
    sendTPDO(pdoNumber, dataBuffer) {
        this.node.sendTPDO(pdoNumber, dataBuffer);
    }
    registerRPDO(pdoNumber, callbackOrCobId) {
        this.node.registerRPDO(pdoNumber, callbackOrCobId);
    }

    // ─── SDO Service Engine ───────────────────────────────────────────────────
    async readTag(tagName) {
        if (!this.node || this.status !== 'OPERATIONAL') {
            throw new Error('Device is not OPERATIONAL');
        }

        const tag = this.tagMap.get(tagName);
        if (!tag) throw new Error(`Tag "${tagName}" not found in EDS map.`);
        if (tag.access === 'wo') throw new Error(`Tag "${tagName}" is write-only.`);

        return await this.node.sdoRead(this.nodeId, tag.index, tag.subIndex);
    }

    async writeTag(tagName, value) {
        if (!this.node || this.status !== 'OPERATIONAL') {
            throw new Error('Device is not OPERATIONAL');
        }

        const tag = this.tagMap.get(tagName);
        if (!tag) throw new Error(`Tag "${tagName}" not found in EDS map.`);
        if (tag.access === 'ro') throw new Error(`Tag "${tagName}" is read-only.`);

        await this.node.sdoWrite(this.nodeId, tag.index, tag.subIndex, value);
    }

    getAvailableTags() {
        return Array.from(this.tagMap.keys());
    }
}

module.exports = { CanopenDevice };
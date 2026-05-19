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
        
        // Accept an injected bus from CanopenNetwork
        this.sharedBus = options.sharedBus || null; 
        this.bus = this.sharedBus;
        
        this.node = null;
        this.eds = null;
        this.tagMap = new Map();
        
        this.status = 'DISCONNECTED';

        if (options.edsFile) {
            this._loadEds(options.edsFile);
        }
    }

    _loadEds(filePath) {
        this.eds = parseEDS(filePath, this.nodeId);
        
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

    async connect() {
        // Only manage bus lifecycle if this is a standalone device
        if (!this.sharedBus) {
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

            this.bus.on('bus_connected', () => this.emit('connected'));
            this.bus.on('bus_disconnected', () => this.emit('disconnected'));
            this.bus.on('bus_reconnecting', (info) => this.emit('reconnecting', info));
            this.bus.on('bus_error', (err) => this.emit('error', err));
        }

        this.node = new CANopenNode({
            bus: this.bus,
            nodeId: this.nodeId,
            deviceName: `Node_${this.nodeId}`,
            heartbeatMs: Math.floor((this.options.heartbeatMs || 3000) / 3),
            config: { 
                heartbeat_timeout_ms: this.options.heartbeatMs || 3000, 
                sdo_timeout_ms: 500, 
                autoResetOnHeartbeatLoss: this.options.autoResetOnHeartbeatLoss ?? false,
                bootUpSelfStart: this.options.bootUpSelfStart ?? true,
                maxSdoQueueDepth: this.options.maxSdoQueueDepth || 100 
            }
        });

        if (this.eds) {
            loadEDSIntoNode(this.node, this.eds);
        }

        this.node._onStatusChange = (nodeId, newStatus, faultCode) => {
            this.status = newStatus;
            this.emit('status_change', { status: newStatus, faultCode });
        };

        // Only trigger bus connect if standalone
        if (!this.sharedBus) {
            await this.bus.connect();
        }
        
        if (this.status !== 'OFFLINE') {
            this.node.start();
        }
    }

    disconnect() {
        if (this.node) this.node.stop();
        // Don't close the socket if it's owned by the CanopenNetwork
        if (this.bus && !this.sharedBus) this.bus.close();
        this.status = 'DISCONNECTED';
    }

    nmtStart(targetNodeId = 0) { this.node.nmtStart(targetNodeId); }
    nmtStop(targetNodeId = 0) { this.node.nmtStop(targetNodeId); }
    nmtReset(targetNodeId = 0) { this.node.nmtReset(targetNodeId); }
    nmtPreOp(targetNodeId = 0) { this.node.nmtPreOp(targetNodeId); }
    nmtResetComm(targetNodeId = 0) { this.node.nmtResetComm(targetNodeId); }

    sendTPDO(pdoNumber, dataBuffer) {
        this.node.sendTPDO(pdoNumber, dataBuffer);
    }
    registerRPDO(pdoNumber, callbackOrCobId) {
        this.node.registerRPDO(pdoNumber, callbackOrCobId);
    }

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

module.exports = { 
    CanopenDevice,
    get CanopenNetwork() { return require('./canopen_network').CanopenNetwork; },
    get CiA402Drive() { return require('./cia402_drive').CiA402Drive; }
};

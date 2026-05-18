/**
 * Bufferstack.IO CANOpen Core - A robust Node.js CANopen library with dynamic EDS parsing,
 * CiA 402 support, and bulletproof physical layer reconnects
 *
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
    /**
     * @param {Object} options
     * @param {number} options.nodeId - The hardware Node ID (1-127)
     * @param {string} options.busType - 'socketcan', 'slcan', 'tcp', or 'virtual'
     * @param {string} [options.interface] - OS interface (e.g., 'can0')
     * @param {string} [options.commPort] - Serial port (e.g., 'COM5', '/dev/ttyUSB0')
     * @param {string} [options.tcpHost] - IP of Ethernet-to-CAN gateway
     * @param {number} [options.tcpPort] - Port of Ethernet-to-CAN gateway
     * @param {number} [options.baudRate=115200] - Serial baud rate
     * @param {string} [options.edsFile] - Path to the device's EDS file
     * @param {number} [options.heartbeatMs=3000] - Expected heartbeat interval
     */
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
                    // Sanitize the name to ensure clean property access
                    const safeName = entry.name.replace(/[^a-zA-Z0-9_]/g, '_');
                    
                    // Prevent collisions (e.g., if two sub-indices have the same name)
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
     * Inherits the exponential backoff from canopen_bus.js.
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
                auto_reset_on_timeout: true 
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
        
        // Boot the node once the physical bus is up
        setTimeout(() => {
            if (this.status !== 'OFFLINE') this.node.start();
        }, 500);
    }

    disconnect() {
        if (this.node) this.node.stop();
        if (this.bus) this.bus.close();
        this.status = 'DISCONNECTED';
    }

    /**
     * Look up coordinates from the EDS map and execute an SDO Read over the network.
     */
    async readTag(tagName) {
        if (!this.node || this.status !== 'OPERATIONAL') {
            throw new Error('Device is not OPERATIONAL');
        }

        const tag = this.tagMap.get(tagName);
        if (!tag) throw new Error(`Tag "${tagName}" not found in EDS map.`);
        if (tag.access === 'wo') throw new Error(`Tag "${tagName}" is write-only.`);

        return await this.node.sdoRead(this.nodeId, tag.index, tag.subIndex);
    }

    /**
     * Look up coordinates from the EDS map and execute an SDO Write over the network.
     */
    async writeTag(tagName, value) {
        if (!this.node || this.status !== 'OPERATIONAL') {
            throw new Error('Device is not OPERATIONAL');
        }

        const tag = this.tagMap.get(tagName);
        if (!tag) throw new Error(`Tag "${tagName}" not found in EDS map.`);
        if (tag.access === 'ro') throw new Error(`Tag "${tagName}" is read-only.`);

        await this.node.sdoWrite(this.nodeId, tag.index, tag.subIndex, value);
    }

    /**
     * Get a list of all available tags derived from the EDS file.
     */
    getAvailableTags() {
        return Array.from(this.tagMap.keys());
    }
}

module.exports = { CanopenDevice };

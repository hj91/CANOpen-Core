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
const { CanopenDevice } = require('./index');

class CanopenNetwork extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.bus = null;
        this.devices = new Map();
        this.status = 'DISCONNECTED';
    }

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

        this.bus.on('bus_connected', () => {
            this.status = 'CONNECTED';
            this.emit('connected');
        });
        this.bus.on('bus_disconnected', () => {
            this.status = 'DISCONNECTED';
            this.emit('disconnected');
        });
        this.bus.on('bus_reconnecting', (info) => this.emit('reconnecting', info));
        this.bus.on('bus_error', (err) => this.emit('error', err));

        await this.bus.connect();
    }

    disconnect() {
        for (const device of this.devices.values()) {
            device.disconnect();
        }
        if (this.bus) this.bus.close();
        this.status = 'DISCONNECTED';
    }

    addDevice(nodeId, edsFile, deviceOptions = {}) {
        if (!this.bus) {
            throw new Error('Must connect CanopenNetwork before adding devices.');
        }

        const device = new CanopenDevice({
            nodeId,
            edsFile,
            sharedBus: this.bus, 
            ...deviceOptions
        });

        this.devices.set(nodeId, device);
        return device;
    }

    getDevice(nodeId) {
        return this.devices.get(nodeId);
    }

    nmtStartAll()     { if (this.bus) this.bus.send(0x000, [0x01, 0]); }
    nmtStopAll()      { if (this.bus) this.bus.send(0x000, [0x02, 0]); }
    nmtResetAll()     { if (this.bus) this.bus.send(0x000, [0x81, 0]); }
    nmtPreOpAll()     { if (this.bus) this.bus.send(0x000, [0x80, 0]); }
}

module.exports = { CanopenNetwork };

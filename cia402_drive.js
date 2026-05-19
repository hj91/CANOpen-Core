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

const { CanopenDevice } = require('./index');

class CiA402Drive extends CanopenDevice {
    constructor(options) {
        super(options);
        this.CW_TAG = options.controlWordTag || 'Controlword';
        this.SW_TAG = options.statusWordTag  || 'Statusword';
        this.MODE_TAG = options.modeTag      || 'Modes_of_operation';
    }

    async powerOn() {
        await this.writeTag(this.CW_TAG, 0x0080);
        await new Promise(r => setTimeout(r, 50)); 

        await this.writeTag(this.CW_TAG, 0x0006);
        await new Promise(r => setTimeout(r, 10));

        await this.writeTag(this.CW_TAG, 0x0007);
        await new Promise(r => setTimeout(r, 10));

        await this.writeTag(this.CW_TAG, 0x000F);
    }

    async quickStop() {
        await this.writeTag(this.CW_TAG, 0x000B);
    }

    async powerOff() {
        await this.writeTag(this.CW_TAG, 0x0000);
    }

    async setMode(modeNumber) {
        await this.writeTag(this.MODE_TAG, modeNumber);
    }

    async getDriveState() {
        const sw = await this.readTag(this.SW_TAG);
        const masked = sw & 0x006F;
        
        const states = {
            0x00: 'NOT_READY',          
            0x40: 'SWITCH_ON_DISABLED',
            0x21: 'READY_TO_SWITCH_ON', 
            0x23: 'SWITCHED_ON',
            0x27: 'OPERATION_ENABLED',  
            0x07: 'QUICK_STOP_ACTIVE',
            0x0F: 'FAULT_REACTION_ACTIVE', 
            0x08: 'FAULT'
        };
        return states[masked] || 'UNKNOWN';
    }
}


module.exports = { CiA402Drive };

# Bufferstack.IO CANOpen Core

A robust, pure Node.js CANopen library designed for harsh industrial environments.

Bufferstack.IO `canopen-core` provides dynamic EDS (Electronic Data Sheet) parsing, CiA 402 motion profile support, and a highly resilient physical layer connection engine. It abstracts away complex CANopen state machines and object dictionaries, exposing a clean, tag-based async API for your Node.js applications.

## Features

* **Bulletproof Connection Engine:** Built from the ground up to survive physical layer faults. Features an automated exponential backoff and total socket teardown/rebuild pattern to recover from severed cables, network drops, or hardware faults without leaking memory.
* **Network Master Class:** Easily multiplex a single physical CAN bus across multiple devices asynchronously without socket locking.
* **Deterministic Concurrency:** Features bounded FIFO queues for SDO reads and writes to prevent memory leaks on degraded networks during high-frequency telemetry polling.
* **Dynamic EDS Mapping:** Never memorize an Object Dictionary index again. Pass in an `.eds` file, and the library builds a flat map of named tags (e.g., `readTag('ControlWord')` instead of `0x6040, sub 0`). Includes a highly forgiving parser for non-standard hex suffixes and node ID math.
* **Hardware Agnostic:** Seamlessly switch between physical transports using a unified API:
  * `socketcan` (Native Linux CAN interfaces like `can0`)
  * `slcan` (Lawicel-protocol USB adapters)
  * `tcp` (Transparent Ethernet-to-CAN gateways)
  * `virtual` (In-memory bus for local testing)
* **CiA 402 Support:** Native handling for CiA 402 drive profiles and state machines via the `CiA402Drive` extension.

## Installation

```bash
npm install bufferstack-canopen-core

```

**Important Note on Native Dependencies:** Because this library interfaces directly with physical hardware, it relies on native C++ bindings (`rawcan` and `serialport`).

* **Linux Users:** Ensure you have build tools installed (`sudo apt-get install build-essential`).
* **Windows Users:** Ensure you have the windows build tools installed (`npm install -g windows-build-tools`).

## Quick Start (Single Node)

The following example demonstrates how to initialize a device, bind to the connection lifecycle events, and execute application logic using the tag-based API.

```javascript
const { CanopenDevice } = require('bufferstack-canopen-core');

// 1. Initialize the Device Interface
const servo = new CanopenDevice({
    nodeId: 1,
    
    // Select your physical layer routing:
    busType: 'socketcan',     
    interface: 'can0',
    // busType: 'tcp', tcpHost: '192.168.1.100', tcpPort: 8899,
    // busType: 'slcan', commPort: '/dev/ttyUSB0', baudRate: 250000,
    
    edsFile: './eds/motor_controller.eds',
    heartbeatMs: 2000
});

// 2. Bind to Core System Mechanics (Diagnostics & Recovery)
servo.on('connected', () => console.log('[BUS] Hardware interface linked.'));
servo.on('disconnected', () => console.log('[BUS] Hardware interface dropped.'));
servo.on('reconnecting', (info) => {
    console.log(`[BUS] Socket drop. Reconnecting in ${info.delayMs}ms (Attempt ${info.attempt})`);
});
servo.on('error', (err) => console.error(`[BUS] Fault: ${err.message}`));

// 3. Bind to the CANopen State Machine
servo.on('status_change', (info) => {
    console.log(`[NODE] State changed to: ${info.status}`);
    if (info.status === 'OPERATIONAL') {
        runMachineLogic();
    }
});

// 4. Connect (Initiates the automated teardown/rebuild loop)
servo.connect().catch(e => console.error('Initial connect failed:', e.message));

// 5. Execute Application Logic
async function runMachineLogic() {
    try {
        // Example: CiA 402 Drive Enable Sequence
        console.log('Clearing faults...');
        await servo.writeTag('ControlWord', 0x0080); // Fault Reset
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log('Enabling Operation...');
        await servo.writeTag('ControlWord', 0x000F); // Enable Operation
        
        console.log('Setting Target Velocity...');
        await servo.writeTag('TargetVelocity', 1500); 

        // Read Live Telemetry
        const actualVelocity = await servo.readTag('VelocityActualValue');
        const driveTemp = await servo.readTag('DriveTemperature');
        
        console.log(`Live Data -> Speed: ${actualVelocity} RPM | Temp: ${driveTemp}°C`);

    } catch (err) {
        console.error('Logic Error:', err.message);
    }
}

```

## Quick Start (Multi-Node Network)

For systems with multiple devices sharing a single bus, use the `CanopenNetwork` manager to route traffic, and upgrade motor nodes to `CiA402Drive` instances for rapid motion control.

```javascript
const { CanopenNetwork, CiA402Drive } = require('bufferstack-canopen-core');

const network = new CanopenNetwork({ busType: 'socketcan', interface: 'can0' });

async function runSystem() {
    await network.connect(); // Opens physical socket ONCE

    // Register devices and upgrade to motion abstraction
    const axisXConfig = network.addDevice(1, './eds/motor.eds');
    const axisX = new CiA402Drive(axisXConfig.options);
    
    await axisX.connect(); // Attaches to shared socket

    await new Promise(r => setTimeout(r, 1500)); // Wait for OPERATIONAL

    // Execute built-in CiA 402 Machine Logic
    await axisX.powerOn(); 
    await axisX.writeTag('TargetVelocity', 1500); 
}

runSystem();

```

## API Reference

### `new CanopenDevice(options)`

Creates a new device instance.

* `options.nodeId` (Number): The hardware Node ID (1-127). **Required**.
* `options.busType` (String): `'socketcan'`, `'slcan'`, `'tcp'`, or `'virtual'`. **Required** (unless using `sharedBus`).
* `options.edsFile` (String): Path to the device's EDS file.
* `options.heartbeatMs` (Number): Expected heartbeat interval in milliseconds. Default `3000`.
* `options.interface` (String): OS interface name (e.g., `'can0'`). Required for `socketcan`.
* `options.commPort` (String): Serial port path (e.g., `'COM5'`, `'/dev/ttyUSB0'`). Required for `slcan`.
* `options.tcpHost` (String): IP address of the CAN gateway. Required for `tcp`.
* `options.tcpPort` (Number): Port of the CAN gateway. Required for `tcp`.
* `options.baudRate` (Number): Serial baud rate. Default `115200`.
* `options.autoResetOnHeartbeatLoss` (Boolean): If true, autonomously sends an NMT reset to the node if its heartbeat drops. Default `false`.
* `options.bootUpSelfStart` (Boolean): If true, the node automatically transitions to OPERATIONAL on boot. Default `true`.
* `options.maxSdoQueueDepth` (Number): Maximum allowed pending SDO operations before rejecting. Default `100`.
* `options.sharedBus` (Object): An existing bus instance provided by `CanopenNetwork`.

### `device.connect()`

Returns: `Promise<void>`
Initializes the physical connection and boots the node. Natively handles automated reconnects if the socket fails.

### `device.disconnect()`

Safely halts the CANopen node state machine, closes the physical bus socket, and clears all connection timers.

### `device.readTag(tagName)`

* `tagName` (String): The exact string name of the object as defined in the loaded EDS file.
* Returns: `Promise<Number | String | Buffer>`
* Executes a physical SDO read request across the network. Throws an error if the device is not `OPERATIONAL` or if the network times out.

### `device.writeTag(tagName, value)`

* `tagName` (String): The exact string name of the object as defined in the loaded EDS file.
* `value` (Number | String | Buffer): The value to write.
* Returns: `Promise<void>`
* Executes a physical SDO write request.

### `device.getAvailableTags()`

* Returns: `Array<String>`
* Returns a flat array of all valid string tags parsed from the provided EDS file, which can be passed to `readTag()` and `writeTag()`.

### `device.sendTPDO(pdoNumber, dataBuffer)`

* `pdoNumber` (Number): 1-4.
* `dataBuffer` (Array/Buffer): The raw payload to broadcast.

### `device.registerRPDO(pdoNumber, callbackOrCobId)`

Registers an RPDO channel to capture incoming broadcast data.

### `device.nmtStart(targetNodeId)`, `nmtStop()`, `nmtReset()`

Issues targeted NMT master commands. Target `0` to broadcast to all nodes.

---

### `new CanopenNetwork(options)`

Creates a central manager for a physical CAN bus. Accepts the same connection `options` as `CanopenDevice`.

* `network.connect()`, `network.disconnect()`: Lifecycle and physical socket management.
* `network.addDevice(nodeId, edsFile, deviceOptions)`: Registers a node on the network and returns the configuration block.
* `network.nmtStartAll()`, `nmtStopAll()`, `nmtResetAll()`, `nmtPreOpAll()`: Executes NMT broadcast commands across the entire network.

---

### `new CiA402Drive(options)`

Extends `CanopenDevice` with high-level motion control abstractions.

* `drive.powerOn()`: Executes the CiA 402 power-up sequence (Fault Reset -> Ready to Switch On -> Switched On -> Operation Enabled).
* `drive.quickStop()`: Triggers a rapid deceleration fault state.
* `drive.powerOff()`: Drops the power stage.
* `drive.setMode(modeId)`: Changes the CiA 402 operation mode (e.g., 1 = Profile Position, 3 = Profile Velocity).
* `drive.getDriveState()`: Parses the drive's Statusword into a human-readable state string.

## License

This project is licensed under the **Apache License 2.0**. See the LICENSE file for details.

## Author

© 2026 Bufferstack.IO Analytics Technology LLP


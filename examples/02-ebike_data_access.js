// examples/02-ebike_data_access.js

const { CanopenDevice } = require('bufferstack-canopen-core');

// 1. Initialize the Device Interface
const servo = new CanopenDevice({
    nodeId: 1,
    
    // Select your physical layer routing:
    busType: 'tcp',     
    tcpHost: '192.168.1.36',
    tcpPort: 8899,
    
    edsFile: 'example-eds-v4.eds',
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
// We use a flag to prevent starting multiple loops if the state flaps
let isRunning = false; 

servo.on('status_change', (info) => {
    console.log(`[NODE] State changed to: ${info.status}`);
    if (info.status === 'OPERATIONAL' && !isRunning) {
        runMachineLogic();
    }
});

// 4. Connect (Initiates the automated teardown/rebuild loop)
servo.connect().catch(e => console.error('Initial connect failed:', e.message));


// 5. Execute Application Logic
async function runMachineLogic() {
    isRunning = true;
    
    try {
        console.log('Starting E-Bike controller logic...');
        console.log('Setting Output Control...');
        // Write to an 8-bit register (UNSIGNED8 / DataType 0x0005)
        await servo.writeTag('Output_Control', Buffer.from([0x01])); 
        console.log('Reading Telemetry continuously (Press Ctrl+C to stop)...');
    } catch (err) {
        console.error('Startup Logic Error:', err.message);
        isRunning = false;
        return;
    }

    // Continuous Polling Loop
    // This loop safely exits if the hardware drops offline or goes into a fault state
    while (servo.status === 'OPERATIONAL') {
        try {
            // Read live telemetry (Raw Integers)
            const rawMotor = await servo.readTag('Motor_Speed');
            const rawVehicle = await servo.readTag('Vehicle_Speed');
            
            // 1. Cast to Signed 16-bit
            const signedMotor = (rawMotor << 16) >> 16;
            const signedVehicle = (rawVehicle << 16) >> 16;

            // 2. Apply Engineering Scales from the EDS
            const motorRpm = signedMotor * 0.1;
            const vehicleKmh = signedVehicle * 0.01;
            
            console.log(`Live Data -> Motor: ${motorRpm.toFixed(1)} RPM | Vehicle: ${vehicleKmh.toFixed(2)} km/h`);

        } catch (pollErr) {
            // If a single packet drops, we catch it here so it doesn't kill the loop.
            console.warn(`[WARN] Polling frame dropped: ${pollErr.message}`);
        }

        // Wait 500ms before reading the next set of data
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('[NODE] Hardware is no longer OPERATIONAL. Halting telemetry loop.');
    isRunning = false;
}

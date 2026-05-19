// examples/01-eds_reader.js
'use strict';

// 1. Only require the main facade from the package
const { CanopenDevice } = require('bufferstack-canopen-core');

const EDS_FILE = '../example-eds-v4.eds';
const NODE_ID = 1; 

try {
    console.log(`================================================================`);
    console.log(` LOADING & PARSING FIELD NETWORK DICTIONARY`);
    console.log(` FILE: ${EDS_FILE} | RESOLVING FOR NODE ID: ${NODE_ID}`);
    console.log(`================================================================\n`);

    // 2. Initialize the wrapper. It handles the EDS parsing automatically internally.
    const deviceWrapper = new CanopenDevice({
        nodeId: NODE_ID,
        busType: 'virtual', 
        edsFile: EDS_FILE
    });

    // 3. Access the raw parsed data directly through the wrapper's .eds property
    const edsData = deviceWrapper.eds;

    if (!edsData) {
        throw new Error("EDS data failed to load into the device wrapper.");
    }

    // 4. Display High-Level Device Metadata
    console.log(`[DEVICE IDENTIFICATION]`);
    console.log(`  Vendor Name      : ${edsData.deviceInfo.vendorName}`);
    console.log(`  Product Name     : ${edsData.deviceInfo.productName}`);
    console.log(`  Revision Number  : 0x${edsData.deviceInfo.revisionNum.toString(16).toUpperCase()}`);
    console.log(`  File Version     : ${edsData.deviceInfo.fileVersion}`);
    console.log(`  Total OD Objects : ${Object.keys(edsData.od).length}`);
    console.log(`----------------------------------------------------------------\n`);

    // 5. Display Network Communication Maps (PDOs)
    console.log(`[CONFIGURED TRANSMIT PDO MAPS (TPDO - Device broadcasts autonomously)]`);
    for (const [num, tpdo] of Object.entries(edsData.tpdoMaps)) {
        if (!tpdo.signals.length) continue;
        console.log(`  TPDO${num} (COB-ID: 0x${tpdo.cobId.toString(16).toUpperCase()} | TxType: ${tpdo.transmitType})`);
        tpdo.signals.forEach(sig => {
            console.log(`    └─ Tag: "${sig.name.replace(/\s+/g, '_')}" | Index: 0x${sig.index.toString(16).toUpperCase()} Sub: ${sig.subIndex} | BitOffset: ${sig.bitOffset} (${sig.bitLength} bits)`);
        });
    }
    
    console.log(``);
    
    console.log(`[CONFIGURED RECEIVE PDO MAPS (RPDO - Master commands device)]`);
    for (const [num, rpdo] of Object.entries(edsData.rpdoMaps)) {
        if (!rpdo.signals.length) continue;
        console.log(`  RPDO${num} (COB-ID: 0x${rpdo.cobId.toString(16).toUpperCase()})`);
        rpdo.signals.forEach(sig => {
            console.log(`    └─ Tag: "${sig.name.replace(/\s+/g, '_')}" | Index: 0x${sig.index.toString(16).toUpperCase()} Sub: ${sig.subIndex} | BitOffset: ${sig.bitOffset} (${sig.bitLength} bits)`);
        });
    }
    console.log(`----------------------------------------------------------------\n`);

    // 6. Demonstrate the clean, high-level Application Tag API
    console.log(`[FLATTENED APPLICATION TAG MAP]`);
    console.log(`The library automatically normalizes spaces and strips non-alphanumeric`);
    console.log(`characters to expose a clean, string-based API for runtime reads/writes.`);
    console.log(`----------------------------------------------------------------`);
    
    const runtimeTags = deviceWrapper.getAvailableTags();
    
    // Sort and display the flattened, safe tag names alongside their index coordinates
    runtimeTags.sort().forEach(tagName => {
        const coords = deviceWrapper.tagMap.get(tagName);
        const idxHex = `0x${coords.index.toString(16).toUpperCase()}`;
        const subHex = `0x${coords.subIndex.toString(16).toUpperCase().padStart(2, '0')}`;
        
        console.log(`  Tag: ${tagName.padEnd(35)} ──> Address: [Idx: ${idxHex}, Sub: ${subHex}] (${coords.access.toUpperCase()})`);
    });

    console.log(`\n================================================================`);
    console.log(` PARSE COMPLETE: ${runtimeTags.length} valid runtime tags exposed.`);
    console.log(`================================================================`);

} catch (err) {
    console.error(`\n[FATAL PARSE ERROR] Failed to evaluate EDS dictionary layout:`);
    console.error(err.stack);
}

// examples/01-eds_reader.js

'use strict';

const path = require('path');
const { parseEDS } = require('./canopen_eds');
const { CanopenDevice } = require('bufferstack-canopen-core');

// 1. Define the target EDS file path
const EDS_FILE = 'example-eds-v4.eds';
const NODE_ID = 1; // Used to resolve $NODEID expressions like $NODEID+0x180

try {
    console.log(`================================================================`);
    console.log(` LOADING & PARSING FIELD NETWORK DICTIONARY`);
    console.log(` FILE: ${EDS_FILE} | RESOLVING FOR NODE ID: ${NODE_ID}`);
    console.log(`================================================================\n`);

    // 2. Parse the raw EDS structure using the underlying parser module
    const edsData = parseEDS(EDS_FILE, NODE_ID);

    // 3. Display High-Level Device Metadata
    console.log(`[DEVICE IDENTIFICATION]`);
    console.log(`  Vendor Name      : ${edsData.deviceInfo.vendorName}`);
    console.log(`  Product Name     : ${edsData.deviceInfo.productName}`);
    console.log(`  Revision Number  : 0x${edsData.deviceInfo.revisionNum.toString(16).toUpperCase()}`);
    console.log(`  File Version     : ${edsData.deviceInfo.fileVersion}`);
    console.log(`  Total OD Objects : ${Object.keys(edsData.od).length}`);
    console.log(`----------------------------------------------------------------\n`);

    // 4. Display Network Communication Maps (PDOs)
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

    // 5. Initialize the programmatic wrapper to extract valid application tag keys
    console.log(`[FLATTENED APPLICATION TAG MAP]`);
    console.log(`The library automatically normalizes spaces and strips non-alphanumeric`);
    console.log(`characters to expose a clean, string-based API for runtime reads/writes.`);
    console.log(`----------------------------------------------------------------`);
    
    const deviceWrapper = new CanopenDevice({
        nodeId: NODE_ID,
        busType: 'virtual', // Initialized in virtual mode just to extract map schema
        edsFile: EDS_FILE
    });

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

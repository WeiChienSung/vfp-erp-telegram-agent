const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(raw);

const dbPath = config.databasePath;

function analyzePrefixes(dbPath) {
    const fileBuffer = fs.readFileSync(dbPath);
    const recordCount = fileBuffer.readInt32LE(4);
    const headerLength = fileBuffer.readInt16LE(8);
    const recordLength = fileBuffer.readInt16LE(10);

    const fields = [];
    let offset = 32;
    let currentRecordOffset = 1;

    while (offset < headerLength - 1) {
        const fieldBuffer = fileBuffer.subarray(offset, offset + 32);
        if (fieldBuffer[0] === 0x0D) break;
        let ne = 0;
        while (ne < 11 && fieldBuffer[ne] !== 0) ne++;
        const name = fieldBuffer.subarray(0, ne).toString('ascii').trim();
        const type = String.fromCharCode(fieldBuffer[11]);
        const len = fieldBuffer[16];

        fields.push({ name, type, length: len, offset: currentRecordOffset });
        currentRecordOffset += len;
        offset += 32;
    }

    const big5Decoder = new TextDecoder('big5');
    const counts = {};

    for (let r = 0; r < recordCount; r++) {
        const filePos = headerLength + (r * recordLength);
        if (fileBuffer[filePos] === 0x2A) continue;

        const recordBuf = fileBuffer.subarray(filePos, filePos + recordLength);
        
        // Find NAME field
        const nameField = fields.find(f => f.name === 'NAME');
        if (!nameField) continue;

        const rawVal = recordBuf.subarray(nameField.offset, nameField.offset + nameField.length);
        let end = rawVal.length;
        while (end > 0 && (rawVal[end - 1] === 0x20 || rawVal[end - 1] === 0x00)) end--;
        const name = big5Decoder.decode(rawVal.subarray(0, end)).trim();

        if (name.length >= 2) {
            // Extract the first 2 characters
            const prefix2 = name.substring(0, 2);
            counts[prefix2] = (counts[prefix2] || 0) + 1;
        }
        if (name.length >= 3) {
            // Extract the first 3 characters
            const prefix3 = name.substring(0, 3);
            counts[prefix3] = (counts[prefix3] || 0) + 1;
        }
    }

    const sorted = Object.entries(counts)
        .filter(([k, v]) => v >= 5 && /^[\u4e00-\u9fa5]+$/.test(k)) // Only Chinese characters with count >= 5
        .sort((a, b) => b[1] - a[1]);

    console.log("Top Chinese prefixes in product names:");
    sorted.slice(0, 40).forEach(([k, v]) => {
        console.log(`- Prefix: [${k}] Count: ${v}`);
    });
}

try {
    analyzePrefixes(dbPath);
} catch (e) {
    console.error("Error:", e.message);
}

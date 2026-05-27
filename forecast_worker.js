const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const { databasePath, lowStockLeadTimeDays, lowStockFallback, lowStockMin2YearSales, priorityProducts } = workerData;

function normalizeText(str) {
    if (!str) return '';
    return str.toLowerCase()
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/溼/g, '濕').replace(/臺/g, '台').replace(/綿/g, '棉').replace(/双/g, '雙')
        .replace(/国/g, '國').replace(/医/g, '醫').replace(/药/g, '藥').replace(/针/g, '針')
        .replace(/纸/g, '紙').replace(/寸/g, '吋').replace(/尺/g, '呎');
}

function readStockDbRaw(dbPath) {
    if (!fs.existsSync(dbPath)) throw new Error(`找不到資料庫檔案: ${dbPath}`);
    
    let fileBuffer;
    let retries = 3;
    let delay = 150;
    while (retries > 0) {
        try {
            fileBuffer = fs.readFileSync(dbPath);
            break;
        } catch (err) {
            retries--;
            if (retries === 0) throw err;
            const start = Date.now();
            while (Date.now() - start < delay) {}
        }
    }
    
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
    const results = [];
    const targetFields = ['NO', 'NAME', 'UNIT', 'UNITS', 'SCAL', 'INVQT', 'BNO', 'SNO', 'PUPRI'];

    for (let r = 0; r < recordCount; r++) {
        const filePos = headerLength + (r * recordLength);
        if (filePos + recordLength > fileBuffer.length) break;
        if (fileBuffer[filePos] === 0x2A) continue; // deleted

        const recordBuf = fileBuffer.subarray(filePos, filePos + recordLength);
        const record = {};
        for (const f of fields) {
            if (targetFields.includes(f.name)) {
                const rawVal = recordBuf.subarray(f.offset, f.offset + f.length);
                if (f.type === 'N') {
                    record[f.name] = parseFloat(rawVal.toString('ascii').trim()) || 0;
                } else {
                    let end = rawVal.length;
                    while (end > 0 && (rawVal[end - 1] === 0x20 || rawVal[end - 1] === 0x00)) end--;
                    record[f.name] = big5Decoder.decode(rawVal.subarray(0, end));
                }
            }
        }
        if (!record['NO']) continue;
        if (record['NAME']) record['NAME'] = record['NAME'].replace(/\*+$/, '').trim();
        if (record['UNIT']) record['UNIT'] = record['UNIT'].trim();
        results.push(record);
    }
    return results;
}

function queryDbfSimple(dbPath, filterFn, fieldsNeeded) {
    if (!fs.existsSync(dbPath)) return;
    
    let buf;
    let retries = 3;
    let delay = 150;
    while (retries > 0) {
        try {
            buf = fs.readFileSync(dbPath);
            break;
        } catch (err) {
            retries--;
            if (retries === 0) throw err;
            const start = Date.now();
            while (Date.now() - start < delay) {}
        }
    }
    
    const recordCount = buf.readInt32LE(4);
    const headerLen   = buf.readInt16LE(8);
    const recordLen   = buf.readInt16LE(10);

    const fields = [];
    let off = 32;
    let recOff = 1;
    while (off < headerLen - 1) {
        const fb = buf.subarray(off, off + 32);
        if (fb[0] === 0x0D) break;
        let ne = 0;
        while (ne < 11 && fb[ne] !== 0) ne++;
        const name = fb.subarray(0, ne).toString('ascii').trim();
        const type = String.fromCharCode(fb[11]);
        const len  = fb[16];
        if (!fieldsNeeded || fieldsNeeded.includes(name)) {
            fields.push({ name, type, len, off: recOff });
        }
        recOff += len;
        off += 32;
    }

    const big5 = new TextDecoder('big5');
    for (let r = 0; r < recordCount; r++) {
        const pos = headerLen + r * recordLen;
        if (pos + recordLen > buf.length) break;
        if (buf[pos] === 0x2A) continue;
        const rb = buf.subarray(pos, pos + recordLen);
        const record = {};
        for (const f of fields) {
            const raw = rb.subarray(f.off, f.off + f.len);
            if (f.type === 'N') {
                record[f.name] = parseFloat(raw.toString('ascii').trim()) || 0;
            } else {
                let end = raw.length;
                while (end > 0 && (raw[end-1] === 0x20 || raw[end-1] === 0x00)) end--;
                record[f.name] = big5.decode(raw.subarray(0, end));
            }
        }
        filterFn(record);
    }
}

function doCalculation() {
    const leadDays = lowStockLeadTimeDays || 7;
    const fallback = lowStockFallback !== undefined ? lowStockFallback : 5;
    const minSales = lowStockMin2YearSales !== undefined ? lowStockMin2YearSales : 5;
    const dbDir    = path.dirname(databasePath);
    const ougo1Path = path.join(dbDir, 'ougo1.dbf');

    const salesMap = {};
    if (fs.existsSync(ougo1Path)) {
        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - 2);
        const cutoffStr = cutoff.getFullYear().toString() +
            String(cutoff.getMonth() + 1).padStart(2, '0') +
            String(cutoff.getDate()).padStart(2, '0');

        queryDbfSimple(ougo1Path, (rec) => {
            const dat = (rec.DAT || '').trim();
            if (dat.length >= 8 && dat >= cutoffStr) {
                const mno = (rec.MNO || '').trim();
                const qut = parseFloat(rec.QUT) || 0;
                if (mno && qut > 0) salesMap[mno] = (salesMap[mno] || 0) + qut;
            }
        }, ['DAT', 'MNO', 'QUT']);
    }

    const allStock = readStockDbRaw(databasePath);
    const WORK_DAYS_MONTH = 22;
    const MONTHS = 24;
    const items = [];

    for (const item of allStock) {
        const name = item.NAME || '';
        if (name.includes('停產') || name.includes('停用') || name.includes('停售')) continue;

        const stock = item.INVQT || 0;
        if (stock < 0) continue;
        const totalQut = salesMap[item.NO];

        let level, daysLeft = null, avgMonthly = null, avgDailyWork = null, lowWater = null;

        if (totalQut && totalQut >= minSales) {
            avgMonthly   = Math.round((totalQut / MONTHS) * 10) / 10;
            avgDailyWork = Math.round((avgMonthly / WORK_DAYS_MONTH) * 10) / 10;
            lowWater     = Math.max(Math.ceil(avgDailyWork * leadDays), 1);
            daysLeft     = avgDailyWork > 0 ? Math.round(stock / avgDailyWork) : Infinity;

            if (stock <= lowWater) {
                level = daysLeft <= leadDays ? 'urgent' : 'watch';
            } else {
                level = 'healthy';
            }
        } else {
            if (stock > 0 && stock <= fallback) {
                level = 'urgent';
            } else {
                level = 'healthy';
            }
        }

        items.push({
            no: (item.NO || '').trim(),
            name: (item.NAME || '').trim(),
            unit: (item.UNIT || '').trim(),
            stock,
            avgMonthly,
            avgDailyWork,
            lowWater,
            daysLeft: daysLeft === Infinity ? null : daysLeft,
            level
        });
    }

    const urgent  = items.filter(i => i.level === 'urgent').length;
    const watch   = items.filter(i => i.level === 'watch').length;
    const healthy = items.filter(i => i.level === 'healthy').length;

    return {
        items,
        meta: {
            totalActive: items.length,
            urgentCount: urgent,
            watchCount:  watch,
            healthyCount: healthy,
            leadDays,
            minSales,
            fallback,
            priorityProducts: priorityProducts || [],
            generatedAt: new Date().toISOString()
        }
    };
}

try {
    const result = doCalculation();
    parentPort.postMessage({ success: true, data: result });
} catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
}

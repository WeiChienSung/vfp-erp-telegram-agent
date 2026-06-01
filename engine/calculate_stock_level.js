const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const SHADOW_LEVEL_PATH = path.join(__dirname, 'shadow_level.json');

// 1. 載入設定檔
let config = {
    databasePath: "\\\\192.168.1.99\\d\\nmedi\\stock.DBF",
    lowStockThreshold: 5,
    lowStockLeadTimeDays: 7,
    lowStockMin2YearSales: 5,
    priorityProducts: []
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            Object.assign(config, parsed);
        }
    } catch (e) {
        console.error('[水位計算] 載入設定檔失敗:', e.message);
    }
}

// 2. 唯讀二進位分塊讀取器 (高記憶體防護)
function queryDbfOptimized(dbPath, filterFn, options = {}) {
    const { limit = null, reverse = false, fieldsToExtract = null } = options;
    
    if (!fs.existsSync(dbPath)) {
        throw new Error(`找不到資料庫檔案: ${dbPath}`);
    }

    const fd = fs.openSync(dbPath, 'r');
    const metaBuf = Buffer.alloc(32);
    fs.readSync(fd, metaBuf, 0, 32, 0);

    const recordCount = metaBuf.readInt32LE(4);
    const headerLength = metaBuf.readInt16LE(8);
    const recordLength = metaBuf.readInt16LE(10);

    const headerBuf = Buffer.alloc(headerLength);
    fs.readSync(fd, headerBuf, 0, headerLength, 0);

    const fields = [];
    let offset = 32;
    let currentRecordOffset = 1;
    let delField = null;

    while (offset < headerLength - 1) {
        if (headerBuf[offset] === 0x0D) break;
        let ne = 0;
        while (ne < 11 && headerBuf[offset + ne] !== 0) ne++;
        const name = headerBuf.subarray(offset, offset + ne).toString('ascii').trim();
        const type = String.fromCharCode(headerBuf[offset + 11]);
        const len = headerBuf[offset + 16];

        const fieldObj = { name, type, length: len, offset: currentRecordOffset };
        fields.push(fieldObj);
        if (name === 'DEL') delField = fieldObj;
        currentRecordOffset += len;
        offset += 32;
    }

    const big5Decoder = new TextDecoder('big5');
    const results = [];
    const fieldsToProcess = fieldsToExtract ? fields.filter(f => fieldsToExtract.includes(f.name)) : fields;

    const CHUNK_RECORDS = 5000;
    const maxChunkBytes = CHUNK_RECORDS * recordLength;
    const chunkBuf = Buffer.alloc(maxChunkBytes);

    let currentEndRecord = recordCount - 1;
    while (currentEndRecord >= 0 && (limit === null || results.length < limit)) {
        const currentStartRecord = Math.max(0, currentEndRecord - CHUNK_RECORDS + 1);
        const numRecordsInChunk = currentEndRecord - currentStartRecord + 1;
        const chunkBytes = numRecordsInChunk * recordLength;
        const filePos = headerLength + currentStartRecord * recordLength;

        fs.readSync(fd, chunkBuf, 0, chunkBytes, filePos);

        for (let r = numRecordsInChunk - 1; r >= 0; r--) {
            const recOffset = r * recordLength;
            if (chunkBuf[recOffset] === 0x2A) continue; // 排除物理刪除

            if (delField) {
                const delByte = chunkBuf[recOffset + delField.offset];
                if (delByte === 0x59 || delByte === 0x79) continue; // 軟刪除
            }

            const record = {};
            for (const f of fieldsToProcess) {
                const rawVal = chunkBuf.subarray(recOffset + f.offset, recOffset + f.offset + f.length);
                if (f.type === 'N' || f.type === 'F') {
                    record[f.name] = parseFloat(rawVal.toString('ascii').trim()) || 0;
                } else {
                    let end = rawVal.length;
                    while (end > 0 && (rawVal[end - 1] === 0x20 || rawVal[end - 1] === 0x00)) end--;
                    record[f.name] = big5Decoder.decode(rawVal.subarray(0, end));
                }
            }

            if (filterFn(record)) {
                results.push(record);
                if (limit !== null && results.length >= limit) {
                    break;
                }
            }
        }
        currentEndRecord = currentStartRecord - 1;
    }

    fs.closeSync(fd);
    return results;
}

// 主執行函數
async function main() {
    loadConfig();
    const dbDir = path.dirname(config.databasePath);
    const invoiceDbfPath = path.join(dbDir, 'ougo1.dbf'); // 1.3GB 歷史大檔

    console.log(`[水位計算] 開始計算智慧水位預警...`);
    console.log(`[水位計算] 資料庫路徑: ${invoiceDbfPath}`);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90); // 90天前

    const salesMap = {}; // { PRODUCT_NO: totalQty }
    let totalScanned = 0;
    let outOfDateBounds = false;

    // 🚀 逆向分塊掃描 ougo1.dbf，一旦遇到大於 90 天的紀錄即 Early Return 停止掃描！
    try {
        queryDbfOptimized(invoiceDbfPath, (record) => {
            totalScanned++;
            
            // 解析 VFP 日期 (DAT)，格式通常為 YYYYMMDD
            if (record.DAT && record.DAT.length === 8) {
                const year = parseInt(record.DAT.substring(0, 4), 10);
                const month = parseInt(record.DAT.substring(4, 6), 10) - 1;
                const day = parseInt(record.DAT.substring(6, 8), 10);
                const recordDate = new Date(year, month, day);

                if (recordDate < cutoffDate) {
                    outOfDateBounds = true;
                    return true; // 觸發停止，但因為 filterFn 回傳值控管，我們在 filter 內直接中斷
                }

                // 統計銷量
                const prodNo = record.MNO ? record.MNO.trim() : '';
                const qty = record.QUT || 0;
                
                if (prodNo && qty > 0) {
                    salesMap[prodNo] = (salesMap[prodNo] || 0) + qty;
                }
            }
            
            // 偵測到日期超出範圍時，透過回傳 false 限制
            return outOfDateBounds;
        }, {
            reverse: true,
            limit: 500000, // 最大限制保護
            fieldsToExtract: ['DAT', 'MNO', 'QUT']
        });
    } catch (e) {
        console.error('[水位計算] 掃描銷貨明細失敗:', e.message);
        process.exit(1);
    }

    console.log(`[水位計算] 銷量掃描完成，共計掃描 ${totalScanned} 筆近期記錄。`);

    // 3. 讀取商品庫存檔 (ougo.dbf) 以獲取當前商品清單與供應商
    const stockDbfPath = path.join(dbDir, 'ougo.dbf');
    const shadowLevels = {};

    try {
        const stockRecords = queryDbfOptimized(stockDbfPath, (record) => {
            const prodNo = record.NO ? record.NO.trim() : '';
            if (prodNo) {
                const totalSales = salesMap[prodNo] || 0;
                const dailyAvg = totalSales / 90.0;
                
                // 動態前置交期安全天數
                const leadTimeDays = config.lowStockLeadTimeDays || 7;
                const safeDays = Math.max(10, leadTimeDays); // 至少 10 天
                
                const safeLevel = Math.ceil(dailyAvg * safeDays);

                shadowLevels[prodNo] = {
                    prodNo: prodNo,
                    name: record.NAME ? record.NAME.trim() : '',
                    unit: record.UNIT ? record.UNIT.trim() : '',
                    dailyAvg: parseFloat(dailyAvg.toFixed(4)),
                    safeLevel: safeLevel,
                    currentStock: record.INVQT || 0,
                    vendor: record.SUNA ? record.SUNA.trim() : ''
                };
            }
            return false; // 遍歷所有商品
        }, {
            reverse: false,
            fieldsToExtract: ['NO', 'NAME', 'UNIT', 'INVQT', 'SUNA']
        });
    } catch (e) {
        console.error('[水位計算] 讀取商品庫存檔失敗:', e.message);
        process.exit(1);
    }

    // 4. 原子寫入快照檔 shadow_level.json
    try {
        const tempPath = SHADOW_LEVEL_PATH + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(shadowLevels, null, 2), 'utf8');
        fs.renameSync(tempPath, SHADOW_LEVEL_PATH);
        console.log(`[水位計算] 智慧庫存安全水位快照生成成功，共計 ${Object.keys(shadowLevels).length} 筆商品。`);
        process.exit(0);
    } catch (e) {
        console.error('[水位計算] 寫入 shadow_level.json 失敗:', e.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('[水位計算] 未捕獲的異常:', err.message);
    process.exit(1);
});

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'backorder_state.json');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 非同步重試與指數退避輔助函數 (防範 VFP 檔案鎖定，釋放 Event Loop)
async function executeWithRetry(fn, maxRetries = 5, initialDelay = 100) {
    let delay = initialDelay;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLockError = err.code === 'EBUSY' || err.code === 'EPERM' || err.message.includes('locked');
            if (attempt === maxRetries || !isLockError) {
                throw err;
            }
            const jitter = Math.random() * 50; // 加入隨機抖動防止驚群
            console.warn(`[資料庫警告] 檔案鎖定 (嘗試 ${attempt}/${maxRetries}): ${err.message}。將於 ${Math.round(delay + jitter)} 毫秒後重試...`);
            await sleep(delay + jitter);
            delay *= 2; // 指數退避
        }
    }
}

// 唯讀二進位 DBF 讀取器 (快取/記憶體 & Chunked 逆向掃描，高記憶體防護非同步版)
async function queryDbfOptimized(dbPath, filterFn, options = {}) {
    const { 
        limit = null, 
        reverse = false, 
        fieldsToExtract = null 
    } = options;
    
    let actualPath = dbPath;
    if (!fs.existsSync(actualPath)) {
        const dir = path.dirname(dbPath);
        const base = path.basename(dbPath).toLowerCase();
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            const found = files.find(f => f.toLowerCase() === base);
            if (found) {
                actualPath = path.join(dir, found);
            }
        }
    }

    if (!fs.existsSync(actualPath)) {
        throw new Error(`找不到資料庫檔案: ${dbPath}`);
    }
    
    let fileSize;
    let fd;
    const metaBuf = Buffer.alloc(32);
    
    // 使用帶重試的非同步包裝器開啟檔案，防範 VFP 排他鎖定
    try {
        await executeWithRetry(() => {
            fileSize = fs.statSync(actualPath).size;
            fd = fs.openSync(actualPath, 'r');
            fs.readSync(fd, metaBuf, 0, 32, 0);
        }, 5, 100);
    } catch (err) {
        if (fd) {
            try { fs.closeSync(fd); } catch (e) {}
        }
        throw new Error(`無法安全開啟資料庫檔案 ${actualPath} (已重試 5 次): ${err.message}`);
    }
    
    // 記憶體保護：限制 queryDbfInMemory 的使用閾值
    if (fileSize < 50 * 1024 * 1024) {
        if (fd) {
            try { fs.closeSync(fd); } catch (e) {}
        }
        return await queryDbfInMemory(actualPath, filterFn, { limit, reverse, fieldsToExtract });
    }
    
    try {
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

            const fieldObj = {
                name,
                type,
                length: len,
                offset: currentRecordOffset
            };
            fields.push(fieldObj);
            if (name.toUpperCase() === 'DEL') {
                delField = fieldObj;
            }
            currentRecordOffset += len;
            offset += 32;
        }

        const big5Decoder = new TextDecoder('big5');
        const results = [];
        const fieldsToProcess = fieldsToExtract ? fields.filter(f => fieldsToExtract.includes(f.name)) : fields;

        const CHUNK_RECORDS = 5000;
        // 【記憶體優化】：只配置一個緩衝區，在迴圈中重複使用，防止 GC 頻繁回收
        const chunkBuf = Buffer.alloc(CHUNK_RECORDS * recordLength);

        // 輔助解碼與封裝 Record 的函數（實作 Lazy Getter）
        const parseRecord = (buf, recOffset) => {
            if (buf[recOffset] === 0x2A) return null; // 實體刪除

            if (delField) {
                const delByte = buf[recOffset + delField.offset];
                if (delByte === 0x59 || delByte === 0x79) return null; // 軟刪除
            }

            const record = {};
            for (const f of fieldsToProcess) {
                if (f.type === 'N' || f.type === 'F') {
                    const rawVal = buf.subarray(recOffset + f.offset, recOffset + f.offset + f.length);
                    record[f.name] = parseFloat(rawVal.toString('ascii').trim()) || 0;
                } else {
                    const rawVal = buf.subarray(recOffset + f.offset, recOffset + f.offset + f.length);
                    // 【效能優化】：使用屬性 Getter 實現惰性解碼 (Lazy Decoding)
                    Object.defineProperty(record, f.name, {
                        get: function() {
                            let end = rawVal.length;
                            while (end > 0 && (rawVal[end - 1] === 0x20 || rawVal[end - 1] === 0x00)) end--;
                            const decoded = big5Decoder.decode(rawVal.subarray(0, end));
                            // 快取解碼後的結果，避免重複計算
                            Object.defineProperty(this, f.name, { value: decoded, writable: true, enumerable: true });
                            return decoded;
                        },
                        configurable: true,
                        enumerable: true
                    });
                }
            }
            return record;
        };
        
        if (reverse) {
            let currentEndRecord = recordCount - 1;
            while (currentEndRecord >= 0 && (limit === null || results.length < limit)) {
                const currentStartRecord = Math.max(0, currentEndRecord - CHUNK_RECORDS + 1);
                const numRecordsInChunk = currentEndRecord - currentStartRecord + 1;
                const chunkBytes = numRecordsInChunk * recordLength;
                const filePos = headerLength + currentStartRecord * recordLength;
                
                fs.readSync(fd, chunkBuf, 0, chunkBytes, filePos);
                
                for (let r = numRecordsInChunk - 1; r >= 0; r--) {
                    const recOffset = r * recordLength;
                    const record = parseRecord(chunkBuf, recOffset);
                    if (record && filterFn(record)) {
                        // 【記憶體釋放】：實體化匹配成功的物件，防止閉包引用導致大 buffer 無法被 GC
                        const materialized = {};
                        for (const f of fieldsToProcess) {
                            materialized[f.name] = record[f.name];
                        }
                        results.push(materialized);
                        if (limit !== null && results.length >= limit) {
                            break;
                        }
                    }
                }
                currentEndRecord = currentStartRecord - 1;
            }
        } else {
            let currentStartRecord = 0;
            while (currentStartRecord < recordCount && (limit === null || results.length < limit)) {
                const currentEndRecord = Math.min(recordCount - 1, currentStartRecord + CHUNK_RECORDS - 1);
                const numRecordsInChunk = currentEndRecord - currentStartRecord + 1;
                const chunkBytes = numRecordsInChunk * recordLength;
                const filePos = headerLength + currentStartRecord * recordLength;
                
                fs.readSync(fd, chunkBuf, 0, chunkBytes, filePos);
                
                for (let r = 0; r < numRecordsInChunk; r++) {
                    const recOffset = r * recordLength;
                    const record = parseRecord(chunkBuf, recOffset);
                    if (record && filterFn(record)) {
                        const materialized = {};
                        for (const f of fieldsToProcess) {
                            materialized[f.name] = record[f.name];
                        }
                        results.push(materialized);
                        if (limit !== null && results.length >= limit) {
                            break;
                        }
                    }
                }
                currentStartRecord = currentEndRecord + 1;
            }
        }
        return results;
    } finally {
        // 【安全性保障】：無論解析是否中斷，皆保證關閉檔案描述符
        if (fd) {
            try { fs.closeSync(fd); } catch (e) {}
        }
    }
}

async function queryDbfInMemory(dbPath, filterFn, options = {}) {
    const { limit = null, reverse = false, fieldsToExtract = null } = options;
    let fileBuffer;
    // 使用重試機制讀取整個檔案至記憶體，保護商品庫存 DBF
    try {
        fileBuffer = await executeWithRetry(() => {
            return fs.readFileSync(dbPath);
        }, 5, 100);
    } catch (err) {
        throw new Error(`無法安全讀取資料庫檔案 ${dbPath}至記憶體 (已重試 5 次): ${err.message}`);
    }
    const recordCount = fileBuffer.readInt32LE(4);
    const headerLength = fileBuffer.readInt16LE(8);
    const recordLength = fileBuffer.readInt16LE(10);

    const fields = [];
    let offset = 32;
    let currentRecordOffset = 1;
    let delField = null;

    while (offset < headerLength - 1) {
        if (fileBuffer[offset] === 0x0D) break;
        let ne = 0;
        while (ne < 11 && fileBuffer[offset + ne] !== 0) ne++;
        const name = fileBuffer.subarray(offset, offset + ne).toString('ascii').trim();
        const type = String.fromCharCode(fileBuffer[offset + 11]);
        const len = fileBuffer[offset + 16];

        const fieldObj = {
            name,
            type,
            length: len,
            offset: currentRecordOffset
        };
        fields.push(fieldObj);
        // 優化：大小寫不敏感匹配 DEL 軟刪除欄位
        if (name.toUpperCase() === 'DEL') {
            delField = fieldObj;
        }
        currentRecordOffset += len;
        offset += 32;
    }

    const big5Decoder = new TextDecoder('big5');
    const results = [];
    const fieldsToProcess = fieldsToExtract ? fields.filter(f => fieldsToExtract.includes(f.name)) : fields;

    const loop = (r) => {
        const filePos = headerLength + (r * recordLength);
        if (filePos + recordLength > fileBuffer.length) return;
        if (fileBuffer[filePos] === 0x2A) return;

        if (delField) {
            const delByte = fileBuffer[filePos + delField.offset];
            if (delByte === 0x59 || delByte === 0x79) return; // soft-deleted (Y or y)
        }

        const recordBuf = fileBuffer.subarray(filePos, filePos + recordLength);
        const record = {};
        for (const f of fieldsToProcess) {
            const rawVal = recordBuf.subarray(f.offset, f.offset + f.length);
            if (f.type === 'N' || f.type === 'F') {
                record[f.name] = parseFloat(recordBuf.subarray(f.offset, f.offset + f.length).toString('ascii').trim()) || 0;
            } else {
                // 也為 InMemory 查詢加入惰性解碼優化
                Object.defineProperty(record, f.name, {
                    get: function() {
                        let end = rawVal.length;
                        while (end > 0 && (rawVal[end - 1] === 0x20 || rawVal[end - 1] === 0x00)) end--;
                        const decoded = big5Decoder.decode(rawVal.subarray(0, end));
                        Object.defineProperty(this, f.name, { value: decoded, writable: true, enumerable: true });
                        return decoded;
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        }

        if (filterFn(record)) {
            // 實體化匹配成功的結果，防範閉包引用整個大 Buffer 導致記憶體洩漏
            const materialized = {};
            for (const f of fieldsToProcess) {
                materialized[f.name] = record[f.name];
            }
            results.push(materialized);
            if (limit && results.length >= limit) return true;
        }
    };

    if (reverse) {
        for (let r = recordCount - 1; r >= 0; r--) {
            if (loop(r)) break;
        }
    } else {
        for (let r = 0; r < recordCount; r++) {
            if (loop(r)) break;
        }
    }

    return results;
}

// 發送資料至 Google Webhook
function postToWebhook(urlStr, data) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            action: 'sync_backorders',
            data: data
        });

        // 處理 Google WebApp 302 重定向
        function makeRequest(targetUrl, method = 'POST') {
            const url = new URL(targetUrl);
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: method,
                headers: method === 'POST' ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                } : {}
            };

            const req = https.request(options, (res) => {
                // 如果是 302 或 301 重新定向，跟隨重定向，並將方法改為 GET 以讀取回應內容
                if (res.statusCode === 302 || res.statusCode === 301) {
                    const redirectUrl = res.headers.location;
                    if (redirectUrl) {
                        makeRequest(redirectUrl, 'GET');
                        return;
                    }
                }

                let responseData = '';
                res.on('data', (chunk) => { responseData += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(responseData);
                    } else {
                        reject(new Error(`HTTP 錯誤狀態碼: ${res.statusCode}, 回傳內容: ${responseData}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(err);
            });

            if (method === 'POST') {
                req.write(payload);
            }
            req.end();
        }

        makeRequest(urlStr);
    });
}

// 發送資料至 Google Webhook (指數退避重試包裝)
async function postToWebhookWithRetry(urlStr, data, maxRetries = 5, initialDelay = 1000) {
    let delay = initialDelay;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await postToWebhook(urlStr, data);
            return response;
        } catch (err) {
            const isTransientError = 
                err.message.includes('HTTP 錯誤狀態碼: 429') ||
                err.message.includes('HTTP 錯誤狀態碼: 5') ||
                err.code === 'ECONNRESET' ||
                err.code === 'ETIMEDOUT' ||
                err.code === 'ENOTFOUND' ||
                err.code === 'EADDRINUSE';
                
            if (attempt === maxRetries || !isTransientError) {
                throw err;
            }
            
            const jitter = Math.random() * 300;
            console.warn(`[Webhook 警告] Webhook 傳送失敗 (${err.message})，進行第 ${attempt}/${maxRetries} 次重試。將於 ${Math.round(delay + jitter)}ms 後重試...`);
            await new Promise(resolve => setTimeout(resolve, delay + jitter));
            delay *= 2; 
        }
    }
}

// 主執行邏輯
async function main() {
    console.log(`[同步 - ${new Date().toLocaleString()}] 啟動欠貨同步器...`);

    // 1. 載入 config.json
    if (!fs.existsSync(CONFIG_PATH)) {
        console.error('錯誤: 找不到 config.json 設定檔。');
        process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    
    if (!config.databasePath) {
        console.error('錯誤: 設定檔中無 databasePath。');
        process.exit(1);
    }
    
    const webhookUrl = config.backorderWebhookUrl;
    if (!webhookUrl || webhookUrl.includes('您的網頁應用程式網址')) {
        console.log('提示: config.json 中未設定或仍為預設 Webhook 網址，暫跳過同步。');
        process.exit(0);
    }

    const dbDir = path.dirname(config.databasePath);
    // 自動尋找 ougo1.dbf
    const ougo1Path = path.join(dbDir, 'ougo1.dbf');
    if (!fs.existsSync(ougo1Path)) {
        console.error(`錯誤: 找不到銷貨明細資料庫: ${ougo1Path}`);
        process.exit(1);
    }

    // 2. 效能優化：比對 mtimeMs
    const currentMtime = fs.statSync(ougo1Path).mtimeMs;
    let state = { lastMtimeMs: 0 };
    if (fs.existsSync(STATE_PATH)) {
        try {
            state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        } catch (e) {}
    }

    if (state.lastMtimeMs === currentMtime) {
        console.log('資料庫未變更，跳過本次同步。');
        process.exit(0);
    }

    console.log('偵測到資料庫有變更，開始掃描...');

    // 3. 讀取商品基本庫的當前實體庫存 (用於 🟢 🔴 燈號比對)
    const stockMap = {};
    try {
        await queryDbfInMemory(config.databasePath, (rec) => {
            const no = (rec.NO || '').trim();
            const inv = parseFloat(rec.INVQT) || 0;
            if (no) {
                stockMap[no] = inv;
            }
        }, { fieldsToExtract: ['NO', 'INVQT'] });
    } catch (err) {
        console.warn('警告: 讀取商品庫存庫失敗，將預設所有品項庫存為 0:', err.message);
    }

    // 4. 逆向掃描 ougo1.dbf 撈取欠貨狀態
    // 我們只掃描最新的 50000 筆出貨明細以確保效能（約涵蓋 9 個月）
    const processedKeys = new Set();
    const shippedQtyMap = {};
    const activeBackorders = [];
    let scannedCount = 0;
    const maxScanLimit = 50000;

    try {
        await queryDbfOptimized(ougo1Path, (rec) => {
            scannedCount++;
            if (scannedCount > maxScanLimit) {
                return true; // 達到掃描上限，回傳 true 終止掃描
            }

            const custNo = (rec.NO || '').trim();
            const prodNo = (rec.MNO || '').trim();
            if (!custNo || !prodNo) return false;

            const key = `${custNo}_${prodNo}`;
            if (processedKeys.has(key)) return false;

            const remark = ((rec.SP || '') + ' ' + (rec.SP1 || '')).trim();
            const qty = parseFloat(rec.QUT) || 0;

            // 規則一：必須包含「後送」、「候送」、「欠」才視為欠貨
            const isBackorderRemark = remark.includes('後送') || remark.includes('候送') || remark.includes('欠');
            
            // 規則二：若為退貨（數量負數）或包含「請取回/已取回」，則視為結案 (不計入欠貨)
            const isReturn = qty < 0 || remark.includes('請取回') || remark.includes('已取回');

            if (isBackorderRemark && !isReturn) {
                // 正則匹配 "後送 12+1" 或 "後送5" 格式
                const match = remark.match(/(?:後送|候送|送|欠)\s*(\d+)(?:\s*\+\s*(\d+))?/i);
                if (match) {
                    const paidQty = parseInt(match[1]) || 0;
                    const freeQty = match[2] ? parseInt(match[2]) : 0;

                    if (paidQty > 0 || freeQty > 0) {
                        // 智慧判斷：若開立欠貨單時，銷貨數量比後送備註數量少，則代表後送備註是「總訂購量」，實際欠貨量為 (後送數 - 銷貨數)；
                        // 否則，後送備註數即為實際欠貨量。
                        const rawBackorderQty = paidQty + freeQty;
                        const actualBackorderQty = qty < rawBackorderQty ? rawBackorderQty - qty : rawBackorderQty;

                        const shipped = shippedQtyMap[key] || 0;

                        if (shipped >= actualBackorderQty) {
                            // 已經完全出貨，此欠貨結案，跳過
                            processedKeys.add(key);
                        } else {
                            // 未完全出貨，計算剩餘欠貨數量（扣減後續出貨量）
                            let remainingShipped = shipped;
                            let newPaidQty = paidQty;
                            let newFreeQty = freeQty;

                            // 如果是用總訂購量表示，先按比例折算出實際欠貨的 paidQty 和 freeQty
                            if (qty < rawBackorderQty) {
                                const ratio = actualBackorderQty / rawBackorderQty;
                                newPaidQty = Math.round(paidQty * ratio);
                                newFreeQty = Math.max(0, actualBackorderQty - newPaidQty);
                            }

                            if (remainingShipped > 0) {
                                if (remainingShipped >= newPaidQty) {
                                    remainingShipped -= newPaidQty;
                                    newPaidQty = 0;
                                } else {
                                    newPaidQty -= remainingShipped;
                                    remainingShipped = 0;
                                }
                            }
                            if (remainingShipped > 0) {
                                if (remainingShipped >= newFreeQty) {
                                    newFreeQty = 0;
                                } else {
                                    newFreeQty -= remainingShipped;
                                }
                            }

                            // 讀取當前庫存，比對是否充足
                            const currentStock = stockMap[prodNo] || 0;
                            const isStockSufficient = currentStock >= (newPaidQty + newFreeQty);
                            const stockStatus = isStockSufficient ? '🟢已有現貨' : '🔴缺貨中';
                            const invoiceNo = (rec.ACC || '').trim();
                            
                            activeBackorders.push({
                                date: rec.DAT,
                                customerNo: custNo,
                                customerName: (rec.NAME || '').trim(),
                                productNo: prodNo,
                                productName: (rec.MNAME || '').trim(),
                                paidQty: newPaidQty,
                                freeQty: newFreeQty,
                                shippedQty: 0, // 出貨數量預設為 0，避免倉管人員將原始出貨量或後續出貨量進行二次扣減混淆
                                stock: currentStock,
                                stockStatus: stockStatus,
                                remark: remark,
                                invoiceNo: invoiceNo
                            });
                            processedKeys.add(key);
                        }
                    }
                }
            } else {
                // 如果不是欠貨，且是正常出貨 (數量大於0)，則累積到後續出貨數量中
                if (qty > 0 && !isReturn) {
                    shippedQtyMap[key] = (shippedQtyMap[key] || 0) + qty;
                }
            }
            return false; // 我們需要遍歷到限制範圍，因此 filter 永遠回傳 false
        }, {
            reverse: true,
            limit: 100000, // 此處限制已由 filter 內的 maxScanLimit (50,000 筆) 控管
            fieldsToExtract: ['ACC', 'DAT', 'NO', 'NAME', 'MNO', 'MNAME', 'QUT', 'SP', 'SP1']
        });

        console.log(`掃描完成。目前共有 ${activeBackorders.length} 筆活躍欠貨項目。`);

        // 5. 將結果發送至雲端 Google Webhook
        console.log('正在傳輸資料至 Google 試算表...');
        await postToWebhookWithRetry(webhookUrl, activeBackorders);
        console.log('同步成功！');

        // 6. 更新 state 檔案
        state.lastMtimeMs = currentMtime;
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

        process.exit(0);

    } catch (err) {
        console.error('同步失敗:', err.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('未捕獲的異常:', err.message);
    process.exit(1);
});

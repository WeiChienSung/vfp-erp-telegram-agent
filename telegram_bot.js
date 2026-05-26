const fs = require('fs');
const https = require('https');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const ACTIVE_URL_PATH = path.join(__dirname, '..', 'active_url.txt');
const SNAPSHOT_PATH = path.join(__dirname, 'stock_snapshot.json');

// 單一執行鎖：避免啟動多個重複的 Bot 實體
const LOCK_PORT = 28256;
const lockServer = net.createServer();
lockServer.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log('[系統] 偵測到已有另一個 Telegram Bot 實體正在執行中，本實體自動退出。');
        process.exit(0);
    }
});
lockServer.listen(LOCK_PORT, '127.0.0.1', () => {
    console.log(`[系統] 單一執行鎖已成功啟用 (Port: ${LOCK_PORT})。`);
});

// 1. 讀取設定檔
let config = {
    databasePath: "\\\\192.168.1.99\\d\\nmedi\\stock.DBF",
    lowStockThreshold: 5,
    pushTimes: [],
    priorityProducts: [],
    bots: []
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            
            config.databasePath = parsed.databasePath || config.databasePath;
            config.lowStockThreshold = parsed.lowStockThreshold || config.lowStockThreshold;
            config.pushTimes = parsed.pushTimes || config.pushTimes;
            config.priorityProducts = parsed.priorityProducts || [];
            config.bots = parsed.bots || [];
            
            console.log(`[系統] 設定檔載入成功。已載入機器人數量: ${config.bots.length}`);
        } else {
            saveConfig();
            console.log('[系統] 設定檔不存在，已建立預設設定檔。');
        }
    } catch (e) {
        console.error('[錯誤] 載入設定檔失敗:', e.message);
    }
}

function saveConfig() {
    try {
        const fileConfig = {
            databasePath: config.databasePath,
            lowStockThreshold: config.lowStockThreshold,
            pushTimes: config.pushTimes,
            priorityProducts: config.priorityProducts,
            bots: config.bots
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(fileConfig, null, 2), 'utf8');
        console.log('[系統] 設定檔已成功儲存。');
    } catch (e) {
        console.error('[錯誤] 儲存設定檔失敗:', e.message);
    }
}

// 監聽設定檔變更
function setupConfigWatcher() {
    fs.watchFile(CONFIG_PATH, (curr, prev) => {
        console.log('[系統] 偵測到設定檔 config.json 有變更，自動重新載入...');
        loadConfig();
        reconcileBots();
    });
}

// 2. 唯讀解析 Visual FoxPro DBF 檔案 (記憶體快取優化版)
function normalizeText(str) {
    if (!str) return '';
    return str.toLowerCase()
        // 全形英數轉半形
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/溼/g, '濕')
        .replace(/臺/g, '台')
        .replace(/綿/g, '棉')
        .replace(/双/g, '雙')
        .replace(/国/g, '國')
        .replace(/医/g, '醫')
        .replace(/药/g, '藥')
        .replace(/针/g, '針')
        .replace(/纸/g, '紙')
        .replace(/寸/g, '吋')
        .replace(/尺/g, '呎');
}

function readStockDb(dbPath, keyword = null, lowStockOnly = false, lowStockThreshold = 5) {
    if (!fs.existsSync(dbPath)) {
        throw new Error(`找不到資料庫檔案: ${dbPath}`);
    }
    
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

        fields.push({
            name,
            type,
            length: len,
            offset: currentRecordOffset
        });
        currentRecordOffset += len;
        offset += 32;
    }

    const big5Decoder = new TextDecoder('big5');
    const results = [];

    for (let r = 0; r < recordCount; r++) {
        const filePos = headerLength + (r * recordLength);
        if (filePos + recordLength > fileBuffer.length) {
            console.warn(`[資料庫] 警告：讀取位置已超出檔案大小，終止於第 ${r} 筆記錄。`);
            break;
        }
        if (fileBuffer[filePos] === 0x2A) continue;

        const recordBuf = fileBuffer.subarray(filePos, filePos + recordLength);
        const record = {};
        const targetFields = [
            'NO', 'NAME', 'UNIT', 'UNITS', 'SCAL', 'INVQT', 'INVQT1', 'INVQT0', 
            'SAPRIT', 'SAPRI1', 'SAPRIA', 'SAPRITS', 'SAPRIS1', 'SAPRISA',
            'SUNA', 'SUNO', 'BNO', 'BNO1', 'BNO2', 'SNO', 'PUPRI'
        ];
        
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

        if (record['NAME']) {
            record['NAME'] = record['NAME'].replace(/\*+$/, '').trim();
        }
        if (record['UNIT']) {
            record['UNIT'] = record['UNIT'].trim();
        }

        const nameStr = record['NAME'] || '';
        const isStopped = nameStr.includes('停產') || nameStr.includes('停用') || nameStr.includes('停售');

        if (lowStockOnly) {
            if (!isStopped && record['INVQT'] <= lowStockThreshold) {
                results.push(record);
            }
        } else if (keyword) {
            // 1. 去除建檔/調價日期後綴 (YY.MM.DD 或 YYY.MM.DD)
            const nameClean = nameStr.replace(/\b\d{2,3}\.\d{2}\.\d{2}\b/g, '');
            
            // 2. 建立此商品的「分詞版」與「緊湊版」搜尋鍵
            const normName = normalizeText(nameClean);
            const nameSpaced = normName.replace(/[\*\-\+\/\(\)\[\]\（\）\【\】]/g, ' ');
            const nameCompact = normName.replace(/\s+/g, '');
            
            const normNo = normalizeText(record['NO']);
            const normBno = normalizeText(record['BNO']);
            const normBno1 = normalizeText(record['BNO1']);
            
            // 搜尋鍵包含：分詞、緊湊、品號、條碼
            const searchKey = `${nameSpaced} ${nameCompact} ${normNo} ${normBno} ${normBno1}`;
            
            // 3. 將使用者的關鍵字做相同符號拆分
            let cleanQuery = normalizeText(keyword.trim());
            let queryTokens = cleanQuery
                .replace(/[\*\-\+\/\(\)\[\]\（\）\【\】]/g, ' ')
                .split(/[\s　]+/)
                .filter(t => t.length > 0);
            
            const matchesAll = queryTokens.every(token => searchKey.includes(token));
            if (matchesAll) {
                results.push(record);
            }
        } else {
            results.push(record);
        }
    }
    
    return results;
}

// Optimized DBF reader that reads in chunks when scanning backward (for ougo1.dbf)
function queryDbfOptimized(dbPath, filterFn, options = {}) {
    const { 
        limit = null, 
        reverse = false, 
        fieldsToExtract = null 
    } = options;
    
    // Check file case-insensitively
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
    
    // For small files (e.g. < 50MB), read entirely into memory for speed
    const fileSize = fs.statSync(actualPath).size;
    if (fileSize < 50 * 1024 * 1024) {
        return queryDbfInMemory(actualPath, filterFn, { limit, reverse, fieldsToExtract });
    }
    
    // For large files, use chunked reader
    const fd = fs.openSync(actualPath, 'r');
    const metaBuf = Buffer.alloc(32);
    fs.readSync(fd, metaBuf, 0, 32, 0);
    
    const recordCount = metaBuf.readInt32LE(4);
    const headerLength = metaBuf.readInt16LE(8);
    const recordLength = metaBuf.readInt16LE(10);

    // Read header fields
    const headerBuf = Buffer.alloc(headerLength);
    fs.readSync(fd, headerBuf, 0, headerLength, 0);

    const fields = [];
    let offset = 32;
    let currentRecordOffset = 1;

    while (offset < headerLength - 1) {
        if (headerBuf[offset] === 0x0D) break;
        let ne = 0;
        while (ne < 11 && headerBuf[offset + ne] !== 0) ne++;
        const name = headerBuf.subarray(offset, offset + ne).toString('ascii').trim();
        const type = String.fromCharCode(headerBuf[offset + 11]);
        const len = headerBuf[offset + 16];

        fields.push({
            name,
            type,
            length: len,
            offset: currentRecordOffset
        });
        currentRecordOffset += len;
        offset += 32;
    }

    const big5Decoder = new TextDecoder('big5');
    const results = [];
    const fieldsToProcess = fieldsToExtract ? fields.filter(f => fieldsToExtract.includes(f.name)) : fields;

    // Chunk size in records (e.g. 5000 records is ~3.7MB for 747 recordLength)
    const CHUNK_RECORDS = 5000;
    
    if (reverse) {
        let currentEndRecord = recordCount - 1;
        while (currentEndRecord >= 0 && (limit === null || results.length < limit)) {
            const currentStartRecord = Math.max(0, currentEndRecord - CHUNK_RECORDS + 1);
            const numRecordsInChunk = currentEndRecord - currentStartRecord + 1;
            const chunkBytes = numRecordsInChunk * recordLength;
            const filePos = headerLength + currentStartRecord * recordLength;
            
            const chunkBuf = Buffer.alloc(chunkBytes);
            fs.readSync(fd, chunkBuf, 0, chunkBytes, filePos);
            
            // Loop backward through the chunk in memory
            for (let r = numRecordsInChunk - 1; r >= 0; r--) {
                const recOffset = r * recordLength;
                if (chunkBuf[recOffset] === 0x2A) continue; // deleted

                const record = {};
                for (const f of fieldsToProcess) {
                    const rawVal = chunkBuf.subarray(recOffset + f.offset, recOffset + f.offset + f.length);
                    if (f.type === 'N' || f.type === 'F') {
                        record[f.name] = parseFloat(chunkBuf.subarray(recOffset + f.offset, recOffset + f.offset + f.length).toString('ascii').trim()) || 0;
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
    } else {
        // Forward scan (chunked)
        let currentStartRecord = 0;
        while (currentStartRecord < recordCount && (limit === null || results.length < limit)) {
            const currentEndRecord = Math.min(recordCount - 1, currentStartRecord + CHUNK_RECORDS - 1);
            const numRecordsInChunk = currentEndRecord - currentStartRecord + 1;
            const chunkBytes = numRecordsInChunk * recordLength;
            const filePos = headerLength + currentStartRecord * recordLength;
            
            const chunkBuf = Buffer.alloc(chunkBytes);
            fs.readSync(fd, chunkBuf, 0, chunkBytes, filePos);
            
            for (let r = 0; r < numRecordsInChunk; r++) {
                const recOffset = r * recordLength;
                if (chunkBuf[recOffset] === 0x2A) continue; // deleted

                const record = {};
                for (const f of fieldsToProcess) {
                    const rawVal = chunkBuf.subarray(recOffset + f.offset, recOffset + f.offset + f.length);
                    if (f.type === 'N' || f.type === 'F') {
                        record[f.name] = parseFloat(chunkBuf.subarray(recOffset + f.offset, recOffset + f.offset + f.length).toString('ascii').trim()) || 0;
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
            
            currentStartRecord = currentEndRecord + 1;
        }
    }

    fs.closeSync(fd);
    return results;
}

function queryDbfInMemory(dbPath, filterFn, options = {}) {
    const { limit = null, reverse = false, fieldsToExtract = null } = options;
    const fileBuffer = fs.readFileSync(dbPath);
    const recordCount = fileBuffer.readInt32LE(4);
    const headerLength = fileBuffer.readInt16LE(8);
    const recordLength = fileBuffer.readInt16LE(10);

    const fields = [];
    let offset = 32;
    let currentRecordOffset = 1;

    while (offset < headerLength - 1) {
        if (fileBuffer[offset] === 0x0D) break;
        let ne = 0;
        while (ne < 11 && fileBuffer[offset + ne] !== 0) ne++;
        const name = fileBuffer.subarray(offset, offset + ne).toString('ascii').trim();
        const type = String.fromCharCode(fileBuffer[offset + 11]);
        const len = fileBuffer[offset + 16];

        fields.push({
            name,
            type,
            length: len,
            offset: currentRecordOffset
        });
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

        const recordBuf = fileBuffer.subarray(filePos, filePos + recordLength);
        const record = {};
        for (const f of fieldsToProcess) {
            const rawVal = recordBuf.subarray(f.offset, f.offset + f.length);
            if (f.type === 'N' || f.type === 'F') {
                record[f.name] = parseFloat(recordBuf.subarray(f.offset, f.offset + f.length).toString('ascii').trim()) || 0;
            } else {
                let end = rawVal.length;
                while (end > 0 && (rawVal[end - 1] === 0x20 || rawVal[end - 1] === 0x00)) end--;
                record[f.name] = big5Decoder.decode(rawVal.subarray(0, end));
            }
        }

        if (filterFn(record)) {
            results.push(record);
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

function parseCustomerProductQuery(text) {
    const words = text.split(/[\s　]+/).filter(w => w.length >= 1);
    if (words.length < 2) return null;

    let custDbPath;
    try {
        const dbDir = path.dirname(config.databasePath);
        custDbPath = path.join(dbDir, 'CUST.DBF');
    } catch (e) {
        console.error('[分類器] 解析 CUST.DBF 路徑失敗:', e.message);
        return null;
    }

    const wordAnalyses = words.map(word => {
        const norm = normalizeText(word);
        const isPureNumber = /^\d+$/.test(word);
        
        // Search in CUST.DBF
        let customerMatches = [];
        try {
            customerMatches = queryDbfOptimized(custDbPath, (record) => {
                const normNo = normalizeText(record.NO);
                const normName = normalizeText(record.NAME);
                const normName1 = normalizeText(record.NAME1);
                
                if (isPureNumber) {
                    return normNo === norm;
                } else {
                    if (word.length === 1) {
                        // 單字搜尋只允許精確匹配簡稱或代號，防止「膚」、「藥」等字誤判
                        return normNo === norm || normName1 === norm;
                    } else {
                        return normNo.includes(norm) || normName.includes(norm) || normName1.includes(norm);
                    }
                }
            }, { limit: 10, fieldsToExtract: ['NO', 'NAME', 'NAME1'] });

            // 若匹配數大於 3 筆，代表此關鍵字為「藥局」、「公司」等通用後綴，不視為客戶
            if (customerMatches.length > 3) {
                customerMatches = [];
            }
        } catch (e) {
            console.error('[分類器] 查詢 CUST.DBF 失敗:', e.message);
        }

        // Search in stock.DBF
        let productMatches = [];
        try {
            productMatches = readStockDb(config.databasePath, word);
        } catch (e) {
            console.error('[分類器] 查詢 stock.DBF 失敗:', e.message);
        }

        return {
            word,
            norm,
            customerMatches,
            productMatches
        };
    });

    let bestCustomerIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < wordAnalyses.length; i++) {
        const analysis = wordAnalyses[i];
        if (analysis.customerMatches.length === 0) continue;

        let score = 1000 - analysis.customerMatches.length * 10;
        if (analysis.productMatches.length > 0) {
            score -= 500;
        }
        score += analysis.word.length * 10;

        if (score > bestScore) {
            bestScore = score;
            bestCustomerIdx = i;
        }
    }

    if (bestCustomerIdx === -1) {
        return null;
    }

    const customerWord = wordAnalyses[bestCustomerIdx].word;
    const customerRecord = wordAnalyses[bestCustomerIdx].customerMatches[0];
    const productKeywords = words.filter((_, idx) => idx !== bestCustomerIdx);

    const totalProdMatches = productKeywords.reduce((sum, kw) => {
        const wa = wordAnalyses.find(a => a.word === kw);
        return sum + (wa ? wa.productMatches.length : 0);
    }, 0);

    if (totalProdMatches === 0) {
        return null; // No product matches, likely not a customer+product query
    }

    return {
        customerRecord,
        productKeywords,
        customerWord
    };
}

// 3. Telegram API 通訊模組 (免套件)
function sendTelegramMessage(token, chatId, text, replyMarkup = null, retryCount = 3) {
    if (typeof replyMarkup === 'number') {
        retryCount = replyMarkup;
        replyMarkup = null;
    }

    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
    };

    if (replyMarkup) {
        payload.reply_markup = replyMarkup;
    }

    const postData = JSON.stringify(payload);

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 10000
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.error(`[Telegram] 發送訊息失敗 (HTTP ${res.statusCode}):`, body);
            }
        });
    });

    req.on('error', (e) => {
        console.error(`[Telegram] 網路錯誤:`, e.message);
        if (retryCount > 0) {
            console.log(`[Telegram] 5秒後嘗試重新發送... (剩餘重試次數: ${retryCount})`);
            setTimeout(() => sendTelegramMessage(token, chatId, text, replyMarkup, retryCount - 1), 5000);
        }
    });

    req.on('timeout', () => {
        req.destroy();
        console.error('[Telegram] 發送訊息超時');
    });

    req.write(postData);
    req.end();
}

// 格式化商品資訊
function formatProductInfo(item) {
    const name = item.NAME || '未命名商品';
    const no = item.NO || '無編號';
    const scal = item.SCAL || 1;
    const unit = (item.UNIT || '').trim();
    const units = (item.UNITS || '').trim();
    const hasSecondary = scal > 1 && units && units !== unit;
    
    let info = `<b>${name}</b> 編號：<code>${no}</code>\n\n`;
    const formatPrice = (p) => p > 0 ? `<b>${p.toLocaleString()}</b>` : `<b>0</b> <i>(未設定)</i>`;
    
    if (hasSecondary) {
        const scalNum = Math.floor(scal);
        info += `📦 <b>【整${unit}】(${scalNum}${units})</b> • 售價1：${formatPrice(item.SAPRI1)} • 主牌價：${formatPrice(item.SAPRIT)}\n\n`;
        info += `🍾 <b>【單${units}】</b> • 售價1：${formatPrice(item.SAPRIS1)} • 次牌價：${formatPrice(item.SAPRITS)}\n\n`;
        info += `📊 <b>【總庫存數】</b>：<b>${item.INVQT.toLocaleString()}</b> ${units}\n\n`;
    } else {
        info += `📦 <b>【單位：${unit}】</b> • 售價1：${formatPrice(item.SAPRI1)} • 牌價：${formatPrice(item.SAPRIT)}\n\n`;
        info += `📊 <b>【目前庫存】</b>：<b>${item.INVQT.toLocaleString()}</b> ${unit}\n\n`;
    }
    return info;
}

// 全域常用鍵盤樣式 (拆分為管理員專用與一般員工專用)
const ADMIN_KEYBOARD = {
    keyboard: [
        [{"text": "📋 開始盤點"}, {"text": "⚙️ 管理後台"}]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
};

const USER_KEYBOARD = {
    keyboard: [
        [{"text": "📋 開始盤點"}]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
};

// 4. 物件導向機器人執行類別 (TelegramBotInstance)
class TelegramBotInstance {
    constructor(botConfig) {
        this.name = botConfig.name;
        this.token = botConfig.token;
        this.features = botConfig.features || [];
        this.authorizedChats = botConfig.authorizedChats || [];
        this.updateOffset = 0;
        this.pollingActive = false;
        this.currentReq = null;
    }

    updateConfig(botConfig) {
        this.name = botConfig.name;
        this.features = botConfig.features || [];
        this.authorizedChats = botConfig.authorizedChats || [];
    }

    start() {
        if (this.pollingActive) return;
        this.pollingActive = true;
        this.poll();
    }

    stop() {
        this.pollingActive = false;
        if (this.currentReq) {
            try {
                this.currentReq.destroy();
            } catch(e) {}
            this.currentReq = null;
        }
    }

    poll() {
        if (!this.pollingActive) return;

        const pathUrl = `/bot${this.token}/getUpdates?offset=${this.updateOffset}&timeout=30`;
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: pathUrl,
            method: 'GET',
            timeout: 35000
        };

        this.currentReq = https.get(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                this.currentReq = null;
                try {
                    if (res.statusCode === 200) {
                        const data = JSON.parse(body);
                        if (data.ok && data.result.length > 0) {
                            for (const update of data.result) {
                                this.processUpdate(update);
                                this.updateOffset = update.update_id + 1;
                            }
                        }
                    } else if (res.statusCode === 401 || res.statusCode === 404) {
                        console.error(`[Telegram Polling - ${this.name}] Token 無效或錯誤 (HTTP ${res.statusCode})，將於 1 分鐘後重試輪詢...`);
                        if (this.pollingActive) {
                            setTimeout(() => this.poll(), 60000);
                        }
                        return;
                    } else {
                        console.error(`[Telegram Polling - ${this.name}] HTTP 錯誤 ${res.statusCode}`);
                    }
                } catch (err) {
                    console.error(`[Telegram Polling - ${this.name}] 解析 JSON 錯誤:`, err.message);
                }
                if (this.pollingActive) {
                    setTimeout(() => this.poll(), 100);
                }
            });
        });

        this.currentReq.on('error', (e) => {
            this.currentReq = null;
            console.error(`[Telegram Polling - ${this.name}] 網路錯誤:`, e.message);
            if (this.pollingActive) {
                setTimeout(() => this.poll(), 15000);
            }
        });

        this.currentReq.on('timeout', () => {
            if (this.currentReq) {
                this.currentReq.destroy();
                this.currentReq = null;
            }
            if (this.pollingActive) {
                setTimeout(() => this.poll(), 100);
            }
        });
    }

    processUpdate(update) {
        if (!update.message || !update.message.text) return;
        
        const chatId = update.message.chat.id;
        const text = update.message.text.trim();
        const chatName = update.message.chat.title || update.message.chat.username || update.message.chat.first_name || '未知用戶';

        // 決定使用管理員鍵盤或一般用戶鍵盤 (BOT_1 為管理員)
        const isSelf = this.name === 'BOT_1';
        const myKeyboard = isSelf ? ADMIN_KEYBOARD : USER_KEYBOARD;

        console.log(`[訊息 - ${this.name}] 收到來自 [${chatName}] (${chatId}) 的訊息: "${text}"`);

        // 處理 /start 或 /register 註冊指令
        if (text === '/start' || text.startsWith('/register')) {
            if (!this.authorizedChats.includes(chatId)) {
                this.authorizedChats.push(chatId);
                
                updateGlobalBotChats(this.token, this.authorizedChats);
                
                sendTelegramMessage(
                    this.token,
                    chatId, 
                    `🎉 <b>註冊成功！</b>\n\n本聊天室已成功加入「${this.name}」的授權清單。\n\n<b>🔍 啟用功能：</b>\n${this.features.map(f => {
                        if (f === 'query') return '• 價格與庫存查詢 🔍';
                        if (f === 'history') return '• 客戶歷史售價查詢 💰';
                        if (f === 'take') return '• 行動盤點安全通道 📋';
                        if (f === 'push') return '• 每日智慧缺貨日報 🔔';
                        return f;
                    }).join('\n')}\n\n直接輸入<b>商品名稱</b>或<b>商品編號</b>即可查詢。`,
                    myKeyboard
                );
                console.log(`[註冊 - ${this.name}] 已成功註冊新聊天室: [${chatName}] (${chatId})`);
            } else {
                sendTelegramMessage(this.token, chatId, `ℹ️ <b>提示</b>：本聊天室先前已經註冊過了！\n\n直接輸入<b>商品名稱</b>或<b>商品編號</b>即可查詢。`, myKeyboard);
            }
            return;
        }

        // 處理管理後台網址指令 (僅限管理員機器人 BOT_1)
        if (text === '設定' || text.toLowerCase() === '/config' || text === '⚙️ 管理後台') {
            if (isSelf) {
                sendTelegramMessage(
                    this.token,
                    chatId,
                    `🛠️ <b>ERP 隨身助手 - 本機管理後台：</b>\n\n請在安裝此程式的<b>主機電腦</b>上，使用瀏覽器開啟以下連結進行設定：\n🔗 <a href="http://lvh.me:3000/config">http://lvh.me:3000/config</a>\n\n<i>安全提示：為防範 Token 憑證與金鑰外洩，此設定網頁僅限在本機電腦打開，不支援手機或外網開啟。</i>`,
                    myKeyboard
                );
                return;
            }
            // 若非管理員機器人，則不攔截命令，流向商品搜尋以作偽裝
        }

        // 處理盤點網址指令 (從 active_url.txt 讀取)
        if (text === '盤點' || text.toLowerCase() === '/take' || text === '📋 開始盤點') {
            if (!this.features.includes('take')) {
                console.log(`[訊息 - ${this.name}] 該機器人未啟用盤點功能，忽略該指令。`);
                return;
            }
            if (fs.existsSync(ACTIVE_URL_PATH)) {
                try {
                    const currentUrl = fs.readFileSync(ACTIVE_URL_PATH, 'utf8').trim();
                    if (currentUrl) {
                        const inlineKeyboard = {
                            inline_keyboard: [
                                [
                                    {
                                        "text": "🔗 點此開啟行動盤點網頁",
                                        "url": currentUrl
                                    }
                                ]
                            ]
                        };
                        sendTelegramMessage(
                            this.token,
                            chatId,
                            `📋 <b>行動盤點助手網址已就緒：</b>\n\n請點擊下方按鈕開始盤點作業（支援手機掃描與離線存檔）：`,
                            inlineKeyboard
                        );
                        return;
                    }
                } catch (e) {
                    console.error('[錯誤] 讀取盤點網址暫存檔失敗:', e.message);
                }
            }
            sendTelegramMessage(this.token, chatId, `⏳ <b>行動盤點助手目前未啟動。</b>\n請先啟動本機的「行動盤點助手」程式，或在幾秒鐘後重試。`, myKeyboard);
            return;
        }

        // 處理商品查詢
        const hasQuery = this.features.includes('query');
        const hasHistory = this.features.includes('history');
        if (!hasQuery && !hasHistory) {
            console.log(`[訊息 - ${this.name}] 該機器人未啟用查價或歷史價格功能，忽略該指令。`);
            return;
        }

        let keyword = text;
        if (text.toLowerCase().startsWith('/price')) {
            const parts = text.split(/\s+/);
            if (parts.length >= 2) {
                keyword = parts.slice(1).join(' ');
            } else {
                sendTelegramMessage(this.token, chatId, `💡 <b>使用說明：</b>\n請直接輸入商品名稱或編號進行查詢。\n例如：<code>酒精</code> 或 <code>A222-1</code>`, myKeyboard);
                return;
            }
        }

        // 攔截並判斷是否為「客戶專屬歷史售價查詢」
        const historyQuery = parseCustomerProductQuery(keyword);
        if (historyQuery) {
            if (!hasHistory) {
                console.log(`[查詢 - ${this.name}] 偵測到歷史售價查詢，但本機器人未啟用 'history' 功能，降級為一般查詢。`);
            } else {
                const { customerRecord, productKeywords } = historyQuery;
                console.log(`[歷史查詢 - ${this.name}] 客戶: [${customerRecord.NO}] ${customerRecord.NAME}, 商品關鍵字: ${productKeywords.join(' ')}`);
                try {
                    const dbDir = path.dirname(config.databasePath);
                    const ougo1DbPath = path.join(dbDir, 'ougo1.dbf');
                    
                    const history = queryDbfOptimized(ougo1DbPath, (record) => {
                        const custMatch = record.NO === customerRecord.NO || record.NAME.includes(customerRecord.NAME);
                        if (!custMatch) return false;
                        
                        const normMname = normalizeText(record.MNAME);
                        const normMno = normalizeText(record.MNO);
                        return productKeywords.every(kw => normMname.includes(kw) || normMno.includes(kw));
                    }, {
                        reverse: true,
                        limit: 3,
                        fieldsToExtract: ['ACC', 'DAT', 'NO', 'NAME', 'MNO', 'MNAME', 'QUT', 'UNIT', 'PRICE', 'TOT']
                    });
                    
                    let reply = `🔍 <b>客戶專屬歷史售價查詢結果</b>\n`;
                    reply += `🏢 客戶：<b>[${customerRecord.NO}] ${customerRecord.NAME}</b>\n`;
                    reply += `📦 商品關鍵字：<code>${productKeywords.join(' ')}</code>\n\n`;
                    
                    if (history.length === 0) {
                        reply += `<i>此客戶在近期銷貨明細中沒有購買此商品之紀錄。</i>`;
                    } else {
                        reply += `<b>歷史成交紀錄（最近 ${history.length} 次）：</b>\n`;
                        reply += `-----------------------------------\n\n`;
                        
                        history.forEach((rec, idx) => {
                            const dateStr = rec.DAT.substring(0, 4) + '/' + rec.DAT.substring(4, 6) + '/' + rec.DAT.substring(6, 8);
                            reply += `📅 <b>${dateStr}</b>\n`;
                            reply += `🛒 品名：${rec.MNAME} (<code>${rec.MNO}</code>)\n`;
                            reply += `📊 數量：<b>${rec.QUT}</b> ${rec.UNIT.trim()}\n`;
                            reply += `💵 單價：<b>$${rec.PRICE.toLocaleString()}</b>\n`;
                            reply += `💰 小計：$${rec.TOT.toLocaleString()}\n\n`;
                            if (idx < history.length - 1) {
                                reply += `-----------------------------------\n\n`;
                            }
                        });
                    }
                    
                    sendTelegramMessage(this.token, chatId, reply, myKeyboard);
                    return;
                } catch (err) {
                    console.error('[歷史查詢錯誤]', err.message);
                    sendTelegramMessage(this.token, chatId, `⚠️ <b>系統查詢錯誤</b>：\n讀取銷貨歷史失敗。\n(原因: ${err.message})`, myKeyboard);
                    return;
                }
            }
        }

        if (!hasQuery) {
            console.log(`[查詢 - ${this.name}] 關鍵字: "${keyword}"，但本機器人未啟用 'query' 功能，忽略。`);
            sendTelegramMessage(this.token, chatId, `ℹ️ 本機器人未啟用價格與庫存查詢功能。`, myKeyboard);
            return;
        }

        try {
            console.log(`[查詢 - ${this.name}] 關鍵字: "${keyword}"，正在從資料庫讀取: "${config.databasePath}"...`);
            const searchResults = readStockDb(config.databasePath, keyword, false);
            console.log(`[查詢 - ${this.name}] 關鍵字 "${keyword}" 查得 ${searchResults.length} 筆`);
            if (searchResults.length === 0) {
                sendTelegramMessage(this.token, chatId, `❌ 查無符合關鍵字「<b>${keyword}</b>」的商品，請嘗試其他關鍵字。`, myKeyboard);
                return;
            }

            const displayCount = Math.min(searchResults.length, 12);
            let reply = `📋 <b>商品價格查詢結果（共符合 ${searchResults.length} 筆）：</b>\n\n`;

            for (let i = 0; i < displayCount; i++) {
                const item = searchResults[i];
                reply += formatProductInfo(item);
                reply += `-----------------------------------\n\n`;
            }

            if (searchResults.length > 12) {
                reply += `<i>...還有更多商品，請輸入更精確的關鍵字縮小範圍.</i>`;
            }

            sendTelegramMessage(this.token, chatId, reply, myKeyboard);
        } catch (err) {
            console.error('[查詢錯誤]', err.message);
            sendTelegramMessage(this.token, chatId, `⚠️ <b>系統查詢錯誤</b>：\n資料庫可能正被獨佔鎖定中，請稍後再試。\n(錯誤原因: ${err.message})`, myKeyboard);
        }
    }
}

// 5. 全域動態管理與協調機制
const activeBots = new Map();

function reconcileBots() {
    const newBots = config.bots || [];
    
    // 停止不再需要輪詢的機器人
    for (const [token, instance] of activeBots.entries()) {
        const found = newBots.find(b => b.token === token);
        if (!found || (!found.features.includes('query') && !found.features.includes('take') && !found.features.includes('history'))) {
            console.log(`[系統] 停止機器人 [${instance.name}] 的輪詢服務`);
            instance.stop();
            activeBots.delete(token);
        }
    }
    
    // 啟動或更新機器人
    for (const botConfig of newBots) {
        if (!botConfig.token) continue;
        
        const needsPolling = botConfig.features.includes('query') || botConfig.features.includes('take') || botConfig.features.includes('history');
        
        if (!needsPolling) {
            if (activeBots.has(botConfig.token)) {
                console.log(`[系統] 停止機器人 [${botConfig.name}] 的輪詢服務 (功能已關閉)`);
                activeBots.get(botConfig.token).stop();
                activeBots.delete(botConfig.token);
            }
            continue;
        }
        
        if (activeBots.has(botConfig.token)) {
            const instance = activeBots.get(botConfig.token);
            instance.updateConfig(botConfig);
        } else {
            console.log(`[系統] 啟動機器人 [${botConfig.name}] 的輪詢服務...`);
            const instance = new TelegramBotInstance(botConfig);
            activeBots.set(botConfig.token, instance);
            instance.start();
        }
    }
}

function updateGlobalBotChats(token, authorizedChats) {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.bots && Array.isArray(parsed.bots)) {
                const bot = parsed.bots.find(b => b.token === token);
                if (bot) {
                    bot.authorizedChats = authorizedChats;
                    
                    fs.unwatchFile(CONFIG_PATH);
                    fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2), 'utf8');
                    console.log(`[系統] 成功將新 Chat ID 寫入 config.json [${bot.name}]`);
                    
                    config.bots = parsed.bots;
                    
                    setupConfigWatcher();
                }
            }
        }
    } catch (e) {
        console.error('[錯誤] 更新機器人 Chat ID 到設定檔失敗:', e.message);
    }
}

// 6. 每日定時低庫存推播模組
let lastPushDateTime = '';

function checkScheduledPush() {
    const now = new Date();
    const twTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const year = twTime.getUTCFullYear();
    const month = String(twTime.getUTCMonth() + 1).padStart(2, '0');
    const date = String(twTime.getUTCDate()).padStart(2, '0');
    const hours = String(twTime.getUTCHours()).padStart(2, '0');
    const minutes = String(twTime.getUTCMinutes()).padStart(2, '0');
    
    const currentTimeStr = `${hours}:${minutes}`;
    const currentDateTimeStr = `${year}-${month}-${date} ${currentTimeStr}`;

    if (config.pushTimes.includes(currentTimeStr) && lastPushDateTime !== currentDateTimeStr) {
        lastPushDateTime = currentDateTimeStr;
        console.log(`[排程] 觸發定時推播，時間點: ${currentTimeStr}`);
        triggerLowStockPush();
    }
}

function triggerLowStockPush() {
    const pushBots = config.bots.filter(b => b.features && b.features.includes('push') && b.token && b.authorizedChats && b.authorizedChats.length > 0);
    if (pushBots.length === 0) {
        console.log('[排程] 尚未有任何機器人啟用「庫存推播」或無授權聊天室，取消本次推播。');
        return;
    }

    try {
        const allItems = readStockDb(config.databasePath, null, false);
        const activeItems = allItems.filter(item => {
            const name = item.NAME || '';
            return !name.includes('停產') && !name.includes('停用') && !name.includes('停售');
        });

        let previousStockMap = {};
        if (fs.existsSync(SNAPSHOT_PATH)) {
            try {
                previousStockMap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
            } catch (e) {
                console.error('[排程] 載入庫存快照失敗:', e.message);
            }
        }

        const zeroStockTransitions = [];
        const priorityLowStocks = [];

        for (const item of activeItems) {
            const currentStock = item.INVQT || 0;
            const previousStock = previousStockMap[item.NO];

            if (previousStock !== undefined && previousStock > 0 && currentStock <= 0) {
                zeroStockTransitions.push({
                    item,
                    previousStock
                });
            }

            if (config.priorityProducts && config.priorityProducts.includes(item.NO)) {
                if (currentStock <= config.lowStockThreshold) {
                    priorityLowStocks.push(item);
                }
            }
        }

        const currentStockMap = {};
        for (const item of activeItems) {
            currentStockMap[item.NO] = item.INVQT || 0;
        }
        try {
            fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(currentStockMap, null, 2), 'utf8');
            console.log(`[排程] 庫存快照已更新成功。活動商品總數: ${activeItems.length}`);
        } catch (e) {
            console.error('[排程] 寫入庫存快照失敗:', e.message);
        }

        const isFirstRun = Object.keys(previousStockMap).length === 0;

        let reply = '';
        const timeStr = lastPushDateTime.split(' ')[1] || '';

        if (zeroStockTransitions.length > 0) {
            reply += `🔴 <b>【斷貨警報 (剛變為 0 庫存)】</b>\n`;
            zeroStockTransitions.forEach(({ item, previousStock }) => {
                reply += `• <b>${item.NAME}</b> (編號: <code>${item.NO}</code>)\n`;
                reply += `  狀態：庫存已歸零 🚫 (原庫存：${previousStock} ${item.UNIT || '個'})\n\n`;
            });
            reply += `-----------------------------------\n\n`;
        }

        if (priorityLowStocks.length > 0) {
            reply += `🟡 <b>【主力商品低庫存/缺貨警訊】</b>\n`;
            priorityLowStocks.forEach(item => {
                const stockColor = item.INVQT <= 0 ? '🔴 缺貨' : '🟡 低存';
                reply += `⚠️ <b>[${stockColor}]</b> ${formatProductInfo(item)}`;
                reply += `-----------------------------------\n\n`;
            });
        }

        if (reply === '') {
            if (isFirstRun) {
                reply = `✅ <b>智慧庫存系統初始化完成 (${timeStr})</b>\n\n目前所有主力商品庫存皆高於警戒線 (${config.lowStockThreshold})。已建立庫存對照快照，後續將為您即時偵測剛斷貨之品項。`;
            } else {
                console.log('[排程] 今日無新斷貨商品且主力商品庫存正常，不發送 Telegram 訊息。');
                return;
            }
        } else {
            reply = `🔔 <b>智慧缺貨與主力低存日報 (${timeStr})</b>\n\n` + reply;
        }

        for (const bot of pushBots) {
            const myKeyboard = bot.name === 'BOT_1' ? ADMIN_KEYBOARD : USER_KEYBOARD;
            for (const chatId of bot.authorizedChats) {
                sendTelegramMessage(bot.token, chatId, reply, myKeyboard);
            }
        }
    } catch (err) {
        console.error('[排程推播錯誤]', err.message);
        const errMsg = `⚠️ <b>庫存排程推報錯誤</b>：\n無法讀取 ERP 資料庫檔，可能資料庫正被獨佔備份或鎖定中。\n(原因: ${err.message})`;
        for (const bot of pushBots) {
            const myKeyboard = bot.name === 'BOT_1' ? ADMIN_KEYBOARD : USER_KEYBOARD;
            for (const chatId of bot.authorizedChats) {
                sendTelegramMessage(bot.token, chatId, errMsg, myKeyboard);
            }
        }
    }
}

// 7. 啟動程序
console.log('=============================================');
console.log('       Visual FoxPro ERP Telegram Bot        ');
console.log('             多機器人智慧查價系統            ');
console.log('=============================================');
console.log(`[系統] 正在啟動...`);

loadConfig();
reconcileBots();
setupConfigWatcher();

console.log(`[系統] Telegram Bot 動態協調管理器已開啟。`);

// 啟動排程定時檢查 (每 30 秒檢查一次時間)
setInterval(checkScheduledPush, 30000);
console.log(`[系統] 定時排程器已啟動。每天推播時間點: [${config.pushTimes.join(', ')}]`);

console.log('---------------------------------------------');
console.log('服務運行中，可按 Ctrl+C 結束。');

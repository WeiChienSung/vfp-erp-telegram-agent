const fs = require('fs');
const https = require('https');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const ACTIVE_URL_PATH = path.join(__dirname, '..', 'active_url.txt');

// 1. 載入設定檔
let config = {
    databasePath: "\\\\192.168.1.99\\d\\nmedi\\stock.DBF",
    lowStockThreshold: 5,
    pushTimes: [],
    priorityProducts: [],
    bots: [],
    apiToken: ""
};

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        console.log('[系統] 設定檔已成功更新儲存。');
    } catch (e) {
        console.error('[錯誤] 儲存設定檔失敗:', e.message);
    }
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            config = JSON.parse(raw);
            console.log(`[系統] 設定檔載入成功。已註冊機器人數量: ${config.bots ? config.bots.length : 0}`);
            
            // 設定缺少項目補預設值
            if (config.lowStockLeadTimeDays === undefined)  config.lowStockLeadTimeDays = 7;
            if (config.lowStockFallback === undefined)       config.lowStockFallback = 5;
            if (config.lowStockMin2YearSales === undefined)  config.lowStockMin2YearSales = 5;
            
            // 檢查是否已設定 API 金鑰，若無則生成並寫入
            if (!config.apiToken) {
                config.apiToken = crypto.randomBytes(16).toString('hex');
                saveConfig();
                console.log(`[系統] 偵測到未設定 API 金鑰，已自動生成密碼學安全鎖金鑰。`);
            }
            
            // 檢查是否設定了固定穿透子網域，若無則自動分配
            if (!config.subdomain) {
                config.subdomain = "nmedi-erp-take";
                saveConfig();
                console.log(`[系統] 已自動初始化固定穿透子網域: ${config.subdomain}`);
            }
        }
    } catch (e) {
        console.error('[錯誤] 載入設定檔失敗:', e.message);
    }
}



// 盤點上傳工作佇列，序列化寫入 DBF 避免並發鎖定衝突
const uploadQueue = [];
let isProcessingUpload = false;

function processUploadQueue() {
    if (isProcessingUpload || uploadQueue.length === 0) return;
    
    isProcessingUpload = true;
    const task = uploadQueue.shift();
    const { payload, res } = task;
    
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const tempJsonPath = path.join(__dirname, `temp_take_${uniqueId}.json`);
    
    try {
        fs.writeFileSync(tempJsonPath, JSON.stringify(payload, null, 2), 'utf8');
        const dbDir = path.dirname(config.databasePath);
        const psScriptPath = path.join(__dirname, 'append_take.ps1');
        
        const ps = spawn('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-File', psScriptPath,
            '-JsonPath', tempJsonPath,
            '-DbDir', dbDir
        ]);

        let psOutput = '';
        ps.stdout.on('data', data => psOutput += data.toString());
        ps.stderr.on('data', data => psOutput += data.toString());

        let hasClosed = false;
        const timeoutTimer = setTimeout(() => {
            if (hasClosed) return;
            console.error(`[系統] 盤點寫入進程超時 (12秒)，強制關閉進程...`);
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/F', '/T', '/PID', String(ps.pid)]);
                } else {
                    ps.kill('SIGKILL');
                }
            } catch (e) {
                console.error('[系統] 強制關閉進程出錯:', e.message);
            }
        }, 12000);

        ps.on('close', code => {
            hasClosed = true;
            clearTimeout(timeoutTimer);
            try { fs.unlinkSync(tempJsonPath); } catch(e) {}
            isProcessingUpload = false;
            
            if (code === 0) {
                console.log(`[系統] 盤點數據寫入成功 (佇列處理)。PS 輸出: ${psOutput.trim()}`);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true }));
            } else {
                console.error(`[系統] 盤點寫入 DBF 失敗 (佇列處理, Exit code ${code})。PS 輸出: ${psOutput}`);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: `寫入失敗 (Code ${code}): ${psOutput}` }));
            }
            
            // 處理下一個任務
            processUploadQueue();
        });
    } catch (err) {
        try { fs.unlinkSync(tempJsonPath); } catch(e) {}
        isProcessingUpload = false;
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '排隊寫入失敗: ' + err.message }));
        processUploadQueue();
    }
}

// 監聽設定檔變更，自動重載
fs.watchFile(CONFIG_PATH, (curr, prev) => {
    console.log('[系統] 偵測到設定檔 config.json 有變更，自動重新載入...');
    loadConfig();
});

// 2. 唯讀解析 Visual FoxPro DBF 檔案 (與 ERP 隨身查同步)
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

function sleepSync(ms) {
    try {
        const sab = new SharedArrayBuffer(4);
        const int32 = new Int32Array(sab);
        Atomics.wait(int32, 0, 0, ms);
    } catch (e) {
        const start = Date.now();
        while (Date.now() - start < ms) {}
    }
}

function readStockDb(dbPath, keyword = null) {
    if (!fs.existsSync(dbPath)) {
        throw new Error(`找不到資料庫檔案: ${dbPath}`);
    }
    
    let fileBuffer;
    let retries = 3;
    let delay = 150; // 毫秒
    
    while (retries > 0) {
        try {
            fileBuffer = fs.readFileSync(dbPath);
            break;
        } catch (err) {
            retries--;
            if (retries === 0) {
                console.error(`[資料庫] 讀取資料庫失敗，已達最大重試次數: ${err.message}`);
                throw err;
            }
            console.warn(`[資料庫] 讀取資料庫被鎖定或忙碌，剩餘重試次數 ${retries}，將於 ${delay}ms 後重試...`);
            sleepSync(delay);
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
        if (fileBuffer[filePos] === 0x2A) continue; // deleted

        const recordBuf = fileBuffer.subarray(filePos, filePos + recordLength);
        const record = {};
        const targetFields = [
            'NO', 'NAME', 'UNIT', 'UNITS', 'SCAL', 'INVQT', 'INVQT1', 'INVQT0',
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

        if (keyword) {
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
            
            // 3. 將使用者的關鍵字做智慧拆分與搜尋權重排序
            let cleanQuery = normalizeText(keyword.trim());
            let initialParts = cleanQuery
                .replace(/[\*\-\+\/\(\)\[\]\（\）\【\】]/g, ' ')
                .split(/[\s　]+/)
                .filter(t => t.length > 0);
            
            let queryTokens = [];
            for (const part of initialParts) {
                const hasChinese = /[\u4e00-\u9fa5]/.test(part);
                const hasAlphanumeric = /[a-z0-9]/.test(part);
                
                if (hasChinese && !hasAlphanumeric) {
                    // 純中文 (如 "酒精", "針頭") -> 保留完整詞彙
                    queryTokens.push(part);
                } else {
                    // 混合或純英數 (如 "3m1吋膚", "針頭23g", "c203") -> 在中文與英數字邊界上拆分
                    // 保留英數字組合 (e.g. "3m" 保持為 "3m"，而非拆成 "3" 和 "m")
                    const regex = /[a-z0-9]+(?:\.[0-9]+)?|[\u4e00-\u9fa5]/gi;
                    let match;
                    while ((match = regex.exec(part)) !== null) {
                        queryTokens.push(match[0].toLowerCase());
                    }
                }
            }
            queryTokens = Array.from(new Set(queryTokens));
            
            let score = 0;
            const compactQuery = cleanQuery.replace(/[\s\*\-\+\/\(\)\[\]\（\）\【\】]/g, '');
            
            // 優先級 1：緊湊字串完全匹配 (如 "3m1吋膚" -> "3m通氣紙膠膚色1吋") -> 滿分 100
            if (nameCompact.includes(compactQuery) || normNo.includes(compactQuery) || normBno.includes(compactQuery) || normBno1.includes(compactQuery)) {
                score = 100;
            } else if (queryTokens.length > 0) {
                // 優先級 2：分詞 AND 匹配 -> 分數 10
                const matchesAll = queryTokens.every(token => searchKey.includes(token));
                if (matchesAll) {
                    score = 10;
                }
            }
            
            if (score > 0) {
                record._score = score;
                results.push(record);
            }
        } else {
            results.push(record);
        }
    }
    
    if (keyword) {
        results.sort((a, b) => b._score - a._score);
    }
    
    return results;
}

// 3. Telegram API 發送訊息 (支援動態 Token)
function sendTelegramMessage(token, chatId, text) {
    const postData = JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
    });

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

    const req = https.request(options);
    req.on('timeout', () => {
        req.destroy();
        console.error('[Telegram] 發送超時，已主動銷毀 Socket 連線');
    });
    req.on('error', (e) => console.error(`[Telegram 推送錯誤]:`, e.message));
    req.write(postData);
    req.end();
}



// =============================================
// HTTP 網頁伺服器與 Localtunnel 安全通道
// =============================================
let tunnelUrl = '';

let ltProcess = null;
let tunnelCheckInterval = null;
let ltStartupTimeout = null;
let ltSubdomainRetryCount = 0;
let isFirstTunnelConnection = true;

function checkTunnelAlive(url) {
    if (!url) return;
    console.log(`[存活檢測] 正在檢測外網通道存活狀態: ${url}`);
    
    // 發送一個簡單的 GET 請求給我們自己的外網網址的靜態檔案 (以防 API 造成額外 DB 負擔)
    const parsed = new URL(url);
    const options = {
        hostname: parsed.hostname,
        port: 443,
        path: '/index.js',
        method: 'GET',
        rejectUnauthorized: false // 忽略可能發生的 SSL 憑證錯誤
    };

    let isFinished = false;
    const req = https.request(options, (res) => {
        isFinished = true;
        clearTimeout(timeoutTimer);
        if (res.statusCode === 200) {
            console.log(`[存活檢測] 外網通道正常！(Status: ${res.statusCode})`);
        } else {
            console.warn(`[存活檢測] 外網通道回應異常！Status: ${res.statusCode}，準備重建通道...`);
            rebuildTunnel();
        }
    });

    // 建立 8 秒手動連線與讀取超時保護，防範 DNS/TCP 握手階段掛起
    const timeoutTimer = setTimeout(() => {
        if (!isFinished) {
            req.destroy();
            console.error(`[存活檢測] 外網通道連線或回應超時 (8秒無回應)，準備重建通道...`);
            rebuildTunnel();
        }
    }, 8000);

    req.on('error', (e) => {
        isFinished = true;
        clearTimeout(timeoutTimer);
        console.error(`[存活檢測] 外網通道連線失敗: ${e.message}，準備重建通道...`);
        rebuildTunnel();
    });

    req.end();
}

function rebuildTunnel() {
    if (tunnelCheckInterval) {
        clearInterval(tunnelCheckInterval);
        tunnelCheckInterval = null;
    }
    if (ltStartupTimeout) {
        clearTimeout(ltStartupTimeout);
        ltStartupTimeout = null;
    }
    if (ltProcess) {
        console.log('[系統] 正在重建通道，關閉舊的 Localtunnel 進程...');
        try {
            // 在 Windows 上使用 taskkill /F /T /PID 強制關閉整個進程樹，避免殘留孤兒 node.exe 進程佔用子網域
            if (process.platform === 'win32') {
                spawn('taskkill', ['/F', '/T', '/PID', String(ltProcess.pid)]);
            } else {
                ltProcess.kill('SIGTERM');
            }
        } catch(e) {
            console.error('[錯誤] 關閉 Localtunnel 進程失敗:', e.message);
        }
    }
}

function startTunnel() {
    const subdomainVal = config.subdomain || "nmedi-erp-take";
    console.log(`[系統] 正在建立 Localtunnel 安全加密通道 (固定子網域: ${subdomainVal})...`);
    
    if (ltStartupTimeout) clearTimeout(ltStartupTimeout);
    
    // 使用 npx -y 確保自動下載並運行，不會因 npm 提示交互而掛起
    ltProcess = spawn('npx.cmd', ['-y', 'localtunnel', '--port', '3000', '--subdomain', subdomainVal], { shell: true });
    
    // 設定 20 秒啟動超時保護，如果 20 秒內沒有成功建立通道，則強制重試自愈
    ltStartupTimeout = setTimeout(() => {
        console.warn('[系統] Localtunnel 建立通道超時 (20秒未分配網址)，強制重建...');
        rebuildTunnel();
    }, 20000);
    
    ltProcess.stdout.on('data', (data) => {
        const text = data.toString();
        console.log(`[Localtunnel] ${text.trim()}`);
        if (text.includes('your url is:')) {
            // 成功獲取網址，清除啟動超時保護
            if (ltStartupTimeout) {
                clearTimeout(ltStartupTimeout);
                ltStartupTimeout = null;
            }
            
            const match = text.match(/https:\/\/[^\s]+/);
            if (match) {
                const baseTunnelUrl = match[0].trim();
                
                // 檢查實際獲取的子網域是否相符，如果不相符，代表舊通道被佔用尚未被網關釋放
                if (!baseTunnelUrl.includes(subdomainVal)) {
                    console.warn(`[Localtunnel 提示] 要求的固定子網域 "${subdomainVal}" 目前被佔用或不可用。已安全降級使用分配到的臨時隨機網址: ${baseTunnelUrl}`);
                } else {
                    console.log(`[Localtunnel] 成功取得要求的固定子網域: ${baseTunnelUrl}`);
                }
                
                // 加上金鑰 Token
                tunnelUrl = `${baseTunnelUrl}?token=${config.apiToken}`;
                console.log(`[系統] 行動盤點安全網址已建立 (已附加金鑰): ${tunnelUrl}`);
                
                // 寫入共用網址檔案，供 ERP 隨身查 Bot 查詢
                fs.writeFileSync(ACTIVE_URL_PATH, tunnelUrl, 'utf8');
                
                // 僅更新網址狀態，不主動發送 Telegram 啟動推播，避免重啟打擾同仁
                if (isFirstTunnelConnection) {
                    console.log('[系統] 行動盤點助手啟動成功，已略過啟動 Telegram 推播以防打擾同仁。');
                    isFirstTunnelConnection = false;
                } else {
                    console.log('[系統] 自愈重連成功，網址已更新，但不重複發送 Telegram 推播通知以防打擾。');
                }

                // 啟動定時存活檢查 (每 1.5 分鐘檢查一次)
                if (tunnelCheckInterval) clearInterval(tunnelCheckInterval);
                tunnelCheckInterval = setInterval(() => {
                    checkTunnelAlive(baseTunnelUrl);
                }, 90000);
            }
        }
    });

    ltProcess.stderr.on('data', (data) => console.error(`[Localtunnel 錯誤] ${data.toString().trim()}`));

    ltProcess.on('close', (code) => {
        console.log(`[系統] Localtunnel 通道已關閉，代碼: ${code}。5秒後嘗試重新建立...`);
        cleanupUrlFile();
        ltProcess = null;
        if (tunnelCheckInterval) {
            clearInterval(tunnelCheckInterval);
            tunnelCheckInterval = null;
        }
        if (ltStartupTimeout) {
            clearTimeout(ltStartupTimeout);
            ltStartupTimeout = null;
        }
        setTimeout(startTunnel, 5000);
    });
}

// 根據勾選了 'take' 功能的機器人向對應 authorizedChats 推送
function sendTunnelUrlToChats() {
    if (!tunnelUrl || !config.bots || config.bots.length === 0) return;
    
    config.bots.forEach(bot => {
        if (bot.features && bot.features.includes("take") && bot.token && bot.authorizedChats) {
            bot.authorizedChats.forEach(chatId => {
                sendTelegramMessage(
                    bot.token,
                    chatId,
                    `📋 <b>行動盤點助手已啟動！</b>\n\n請用手機點擊以下連結開始盤點作業（支援鏡頭條碼掃描與防斷線存檔）：\n🔗 <a href="${tunnelUrl}">${tunnelUrl}</a>\n\n<i>提示：盤點中途若網址關閉，直接在 Telegram 輸入「<b>盤點</b>」即可重新獲取網址。</i>`
                );
            });
        }
    });
}

function cleanupUrlFile() {
    try {
        if (fs.existsSync(ACTIVE_URL_PATH)) {
            fs.unlinkSync(ACTIVE_URL_PATH);
            console.log('[系統] 已清除共用網址暫存檔。');
        }
    } catch(e) {}
}

function serveStaticFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('檔案不存在');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
}

function getAllSuppliers(dbPath) {
    const items = readStockDb(dbPath);
    const supplierSet = new Map();
    for (const item of items) {
        const name = (item.SUNA || '').trim();
        const code = (item.SUNO || '').trim();
        if (name) {
            supplierSet.set(name, code);
        }
    }
    return Array.from(supplierSet.entries()).map(([name, code]) => ({ name, code }));
}

function getProductsBySupplier(dbPath, supplier) {
    const items = readStockDb(dbPath);
    const filtered = items.filter(item => {
        const name = (item.SUNA || '').trim();
        const code = (item.SUNO || '').trim();
        return name === supplier || code === supplier;
    });
    return filtered.map(item => ({
        NO: item.NO,
        NAME: item.NAME,
        UNIT: item.UNIT,
        UNITS: item.UNITS,
        SCAL: item.SCAL,
        SNO: item.SNO,
        INVQT: item.INVQT,
        PUPRI: item.PUPRI,
        BNO: item.BNO,
        BNO1: item.BNO1,
        SUNA: item.SUNA,
        SUNO: item.SUNO
    }));
}

function getProductsByQuery(dbPath, query) {
    const items = readStockDb(dbPath, query);
    return items.slice(0, 50).map(item => ({
        NO: item.NO,
        NAME: item.NAME,
        UNIT: item.UNIT,
        UNITS: item.UNITS,
        SCAL: item.SCAL,
        SNO: item.SNO,
        INVQT: item.INVQT,
        PUPRI: item.PUPRI,
        BNO: item.BNO,
        BNO1: item.BNO1,
        SUNA: item.SUNA,
        SUNO: item.SUNO
    }));
}

function getProductByBarcode(dbPath, barcode) {
    const items = readStockDb(dbPath);
    const cleanBarcode = barcode.trim().toLowerCase();
    const product = items.find(item => {
        const bno = (item.BNO || '').trim().toLowerCase();
        const bno1 = (item.BNO1 || '').trim().toLowerCase();
        const bno2 = (item.BNO2 || '').trim().toLowerCase();
        const no = (item.NO || '').trim().toLowerCase();
        return bno === cleanBarcode || bno1 === cleanBarcode || bno2 === cleanBarcode || no === cleanBarcode;
    });
    if (product) {
        return {
            NO: product.NO,
            NAME: product.NAME,
            UNIT: product.UNIT,
            UNITS: product.UNITS,
            SCAL: product.SCAL,
            SNO: product.SNO,
            INVQT: product.INVQT,
            PUPRI: product.PUPRI,
            BNO: product.BNO,
            BNO1: product.BNO1,
            SUNA: product.SUNA,
            SUNO: product.SUNO
        };
    }
    return null;
}

function startWebServer() {
    const server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        // 偵測是否為本地端請求 (防範 Localtunnel 代理穿透)
        const remoteIp = req.socket.remoteAddress;
        const host = req.headers.host || '';
        const cleanHost = host.split(':')[0].toLowerCase();
        const isHostLocal = cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === 'lvh.me';
        const hasForwarded = req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'];
        
        const isLocal = (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') && isHostLocal && !hasForwarded;

        // 設定頁面與 API 安全鎖定 (限本機開啟)
        const isConfigPath = pathname === '/config' || pathname === '/config.html' || pathname.startsWith('/api/config') || pathname === '/config.css' || pathname === '/config.js';
        
        if (isConfigPath && !isLocal) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: 設定後台僅能於本機電腦 (http://localhost:3000/config) 開啟。');
            return;
        }

        // 外網公開 API 安全驗證鎖 (非本機連線時必須驗證 Token)
        const isPublicApi = pathname.startsWith('/api/') && !pathname.startsWith('/api/config');
        if (isPublicApi && !isLocal) {
            const tokenHeader = req.headers['x-api-token'];
            const tokenQuery = parsedUrl.searchParams.get('token');
            const token = tokenHeader || tokenQuery;
            
            if (token !== config.apiToken) {
                res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('401 Unauthorized: 無效或缺少安全金鑰。');
                return;
            }
        }

        // 靜態網頁路由
        if (pathname === '/' || pathname === '/index.html') {
            serveStaticFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
        } else if (pathname === '/index.css') {
            serveStaticFile(res, path.join(__dirname, 'public', 'index.css'), 'text/css; charset=utf-8');
        } else if (pathname === '/index.js') {
            serveStaticFile(res, path.join(__dirname, 'public', 'index.js'), 'application/javascript; charset=utf-8');
        } 
        // 設定後台路由
        else if (pathname === '/config' || pathname === '/config.html') {
            serveStaticFile(res, path.join(__dirname, 'public', 'config.html'), 'text/html; charset=utf-8');
        } else if (pathname === '/config.css') {
            serveStaticFile(res, path.join(__dirname, 'public', 'config.css'), 'text/css; charset=utf-8');
        } else if (pathname === '/config.js') {
            serveStaticFile(res, path.join(__dirname, 'public', 'config.js'), 'application/javascript; charset=utf-8');
        }

        // API: 讀取設定檔 (限本機)
        else if (pathname === '/api/config' && req.method === 'GET') {
            try {
                if (fs.existsSync(CONFIG_PATH)) {
                    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
                    const parsed = JSON.parse(raw);
                    // 遮蔽敏感憑證，防止洩露
                    if (parsed.apiToken) parsed.apiToken = '******';
                    if (parsed.bots && Array.isArray(parsed.bots)) {
                        parsed.bots.forEach(bot => {
                            if (bot.token) bot.token = '******';
                        });
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(parsed, null, 2));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: '設定檔不存在' }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }
        // API: 寫入設定檔 (限本機)
        else if (pathname === '/api/config' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    // 基本結構寫回檢驗
                    if (!parsed.databasePath) throw new Error('資料庫路徑不可為空');
                    if (!parsed.bots || !Array.isArray(parsed.bots)) throw new Error('bots 必須是陣列格式');
                    
                    // 防寫回遮蔽 ******
                    let oldConfig = {};
                    if (fs.existsSync(CONFIG_PATH)) {
                        try { oldConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
                    }
                    if (parsed.apiToken === '******') {
                        parsed.apiToken = oldConfig.apiToken || '';
                    }
                    if (parsed.bots && oldConfig.bots) {
                        parsed.bots.forEach(bot => {
                            if (bot.token === '******') {
                                const oldBot = oldConfig.bots.find(ob => ob.name === bot.name);
                                if (oldBot) bot.token = oldBot.token;
                            }
                        });
                    }
                    
                    fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2), 'utf8');
                    console.log('[系統] 設定後台寫入 config.json 成功！');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
        }
        // API: 廠商名單
        else if (pathname === '/api/suppliers' && req.method === 'GET') {
            try {
                const suppliers = getAllSuppliers(config.databasePath);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(suppliers));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }

        // API: 商品名單或搜尋
        else if (pathname === '/api/products' && req.method === 'GET') {
            const supplier = parsedUrl.searchParams.get('supplier');
            const query = parsedUrl.searchParams.get('q');
            const nos = parsedUrl.searchParams.get('nos');
            console.log(`[API /api/products] 收到請求 q: "${query}", supplier: "${supplier}", nos: "${nos}"`);
            try {
                let filtered = [];
                if (supplier) {
                    filtered = getProductsBySupplier(config.databasePath, supplier);
                } else if (nos) {
                    const noList = nos.split(',').map(n => n.trim().toLowerCase());
                    const allItems = readStockDb(config.databasePath);
                    filtered = allItems.filter(item => noList.includes((item.NO || '').trim().toLowerCase())).map(item => ({
                        NO: item.NO,
                        NAME: item.NAME,
                        UNIT: item.UNIT,
                        UNITS: item.UNITS,
                        SCAL: item.SCAL,
                        SNO: item.SNO,
                        INVQT: item.INVQT,
                        PUPRI: item.PUPRI,
                        BNO: item.BNO,
                        BNO1: item.BNO1,
                        SUNA: item.SUNA,
                        SUNO: item.SUNO
                    }));
                } else if (query !== null) {
                    filtered = getProductsByQuery(config.databasePath, query);
                }
                console.log(`[API /api/products] 查詢結果筆數: ${filtered.length}`);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(filtered));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }
        // API: 掃描條碼
        else if (pathname === '/api/scan' && req.method === 'GET') {
            const barcode = parsedUrl.searchParams.get('barcode');
            try {
                const product = getProductByBarcode(config.databasePath, barcode);
                if (product) {
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify(product));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: '找不到該條碼對應商品' }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: err.message }));
            }
        }
        // API: 上傳盤點結果 (排入序列佇列，防範並發多 PowerShell 鎖定衝突)
        else if (pathname === '/api/upload' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const payload = JSON.parse(body);
                    // 將盤點寫入任務加入排隊佇列
                    uploadQueue.push({ payload, res });
                    processUploadQueue();
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: '解析 JSON 失敗: ' + err.message }));
                }
            });
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('找不到此頁面');
        }
    });

    server.listen(3000, '0.0.0.0', () => {
        console.log('[系統] 盤點與設定後台網頁伺服器已啟動，監聽 Port 3000。');
        console.log('[系統] 本機設定後台入口：http://localhost:3000/config');
    });
}

// 監聽進程關閉事件，確保清空暫存網址檔
process.on('exit', cleanupUrlFile);
process.on('SIGINT', () => { cleanupUrlFile(); process.exit(0); });
process.on('SIGTERM', () => { cleanupUrlFile(); process.exit(0); });

console.log('=============================================');
console.log('        行動盤點助手與設定伺服器             ');
console.log('=============================================');
console.log(`[系統] 正在啟動...`);

loadConfig();
startWebServer();
startTunnel();

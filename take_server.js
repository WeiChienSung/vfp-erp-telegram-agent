const fs = require('fs');
const https = require('https');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

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
            
            // 檢查是否已設定 API 金鑰，若無則生成並寫入
            if (!config.apiToken) {
                config.apiToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
                saveConfig();
                console.log(`[系統] 偵測到未設定 API 金鑰，已自動生成安全鎖金鑰。`);
            }
        }
    } catch (e) {
        console.error('[錯誤] 載入設定檔失敗:', e.message);
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

function readStockDb(dbPath, keyword = null) {
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
                    // 混合或純英數 (如 "3m1吋膚", "針頭23g", "c203") -> 拆分中英數
                    const regex = /[a-z]+|[0-9]+|[\u4e00-\u9fa5]/g;
                    let match;
                    while ((match = regex.exec(part)) !== null) {
                        queryTokens.push(match[0]);
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
    req.on('error', (e) => console.error(`[Telegram 推送錯誤]:`, e.message));
    req.write(postData);
    req.end();
}

// =============================================
// HTTP 網頁伺服器與 Localtunnel 安全通道
// =============================================
let tunnelUrl = '';

function startTunnel() {
    console.log('[系統] 正在建立 Localtunnel 安全加密通道...');
    const lt = spawn('npx.cmd', ['localtunnel', '--port', '3000'], { shell: true });
    
    lt.stdout.on('data', (data) => {
        const text = data.toString();
        console.log(`[Localtunnel] ${text.trim()}`);
        if (text.includes('your url is:')) {
            const match = text.match(/https:\/\/[^\s]+/);
            if (match) {
                const baseTunnelUrl = match[0].trim();
                // 加上金鑰 Token
                tunnelUrl = `${baseTunnelUrl}?token=${config.apiToken}`;
                console.log(`[系統] 行動盤點安全網址已建立 (已附加金鑰): ${tunnelUrl}`);
                
                // 寫入共用網址檔案，供 ERP 隨身查 Bot 查詢
                fs.writeFileSync(ACTIVE_URL_PATH, tunnelUrl, 'utf8');
                
                // 主動發送訊息給管理員
                sendTunnelUrlToChats();
            }
        }
    });

    lt.stderr.on('data', (data) => console.error(`[Localtunnel 錯誤] ${data.toString().trim()}`));

    lt.on('close', (code) => {
        console.log(`[系統] Localtunnel 通道已關閉，代碼: ${code}。5秒後嘗試重新建立...`);
        cleanupUrlFile();
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
        const isHostLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('lvh.me');
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
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(raw);
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
        // API: 上傳盤點結果
        else if (pathname === '/api/upload' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const payload = JSON.parse(body);
                    const tempJsonPath = path.join(__dirname, 'temp_take.json');
                    fs.writeFileSync(tempJsonPath, JSON.stringify(payload, null, 2), 'utf8');

                    const psScriptPath = path.join(__dirname, 'append_take.ps1');
                    const ps = spawn('powershell.exe', [
                        '-ExecutionPolicy', 'Bypass',
                        '-File', psScriptPath,
                        '-JsonPath', tempJsonPath
                    ]);

                    let psOutput = '';
                    ps.stdout.on('data', data => psOutput += data.toString());
                    ps.stderr.on('data', data => psOutput += data.toString());

                    ps.on('close', code => {
                        try { fs.unlinkSync(tempJsonPath); } catch(e) {}

                        if (code === 0) {
                            console.log(`[系統] 盤點數據上傳成功。PS 輸出: ${psOutput.trim()}`);
                            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ success: true }));
                        } else {
                            console.error(`[系統] 盤點寫入 DBF 失敗 (Exit code ${code})。PS 輸出: ${psOutput}`);
                            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ error: `寫入失敗 (Code ${code}): ${psOutput}` }));
                        }
                    });
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

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fsPromises = fs.promises;

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const ACTIVE_TOKEN_PATH = path.join(__dirname, '..', 'active_token.txt');
const QUEUE_PATH = path.join(__dirname, 'pending_take_queue.json');

// 🔒 1. 隨機安全 Token 生成與持久化 (開機自變)
const activeApiToken = crypto.randomBytes(16).toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 22);

try {
    fs.writeFileSync(ACTIVE_TOKEN_PATH, activeApiToken, 'utf8');
    console.log(`[系統] 開機安全 API Token 已更新，已儲存至 active_token.txt。`);
} catch (e) {
    console.error('[系統警告] 無法寫入 active_token.txt:', e.message);
}

/**
 * 非同步檢測檔案是否存在，並支援超時控制，防止 UNC 網路共用磁碟斷線造成主執行緒阻塞。
 */
async function verifyDatabasePath(filePath, timeoutMs = 2500) {
    let timeoutId;
    
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`檢測資料庫路徑逾時 (${timeoutMs}ms)，請確認網路共用磁碟已連線、IP 正確且無防火牆阻擋。`));
        }, timeoutMs);
    });

    const accessPromise = (async () => {
        try {
            await fsPromises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    })();

    try {
        const exists = await Promise.race([accessPromise, timeoutPromise]);
        if (!exists) {
            throw new Error(`找不到您輸入的資料庫檔案，請確認路徑是否正確或是否有權限讀取。`);
        }
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

// 2. 載入設定檔
let config = {
    databasePath: "\\\\192.168.1.99\\d\\nmedi\\stock.DBF",
    bots: []
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            config = JSON.parse(raw);
            console.log(`[系統] 設定檔載入成功。已註冊機器人數量: ${config.bots ? config.bots.length : 0}`);
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

function isPrivateIp(ip) {
    if (!ip) return false;
    const normalized = ip.replace(/^::ffff:/, '');
    if (normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost') return true;
    if (normalized.startsWith('192.168.') || normalized.startsWith('10.')) return true;
    const parts = normalized.split('.');
    if (parts.length === 4) {
        const p1 = parseInt(parts[0], 10);
        const p2 = parseInt(parts[1], 10);
        if (p1 === 172 && p2 >= 16 && p2 <= 31) return true;
    }
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc00:') || normalized.startsWith('fd00:')) return true;
    return false;
}

// 🕵️ 3. 避讓鎖定偵測 (Locks Radar & Maintenance Mode)
function checkIsLocked() {
    // A. 檢查本地手動避讓標記
    const maintenanceFile = path.join(__dirname, '..', 'maintenance_mode.txt');
    if (fs.existsSync(maintenanceFile)) {
        try {
            const content = fs.readFileSync(maintenanceFile, 'utf8').trim();
            if (content === 'manual' || content === 'remote' || content === 'true') {
                return true;
            }
        } catch (e) {}
    }
    // B. 檢查 NAS locks/ 目錄下的所有鎖定檔案
    try {
        const dbDir = path.dirname(config.databasePath);
        const locksDir = path.join(dbDir, 'locks');
        if (fs.existsSync(locksDir)) {
            const files = fs.readdirSync(locksDir);
            const lockFiles = files.filter(f => f.toLowerCase().endsWith('.lock'));
            if (lockFiles.length > 0) {
                return true;
            }
        }
    } catch (e) {
        // 若連線 NAS 發生錯誤，代表網路中斷，同樣視為鎖定不可寫入
        return true;
    }
    return false;
}

// 📦 4. 盤點寫入與排隊處理邏輯 (append_take.ps1 子進程介接)
function executeAppendTake(item) {
    return new Promise((resolve, reject) => {
        const dbDir = path.dirname(config.databasePath);
        const scriptPath = path.join(__dirname, '..', 'scripts', 'append_take.ps1');
        
        const args = [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            '-DbDir', dbDir,
            '-TakeNo', item.takeNo,
            '-UserCode', item.userCode,
            '-Barcode', item.barcode,
            '-Qty', item.qty,
            '-Unit', item.unit || '',
            '-SubUnit', item.subunit || '',
            '-Vendor', item.vendor || '',
            '-Mode', item.mode || 'add'
        ];

        console.log(`[執行寫入] 執行 append_take.ps1 單號: ${item.takeNo}, 條碼: ${item.barcode}, 數量: ${item.qty}, 模式: ${item.mode}`);
        
        const child = spawn('powershell.exe', args);
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', data => stdout += data);
        child.stderr.on('data', data => stderr += data);

        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`PowerShell 執行失敗 (代碼 ${code}): ${stderr || stdout}`));
                return;
            }
            
            const result = stdout.trim();
            if (result.startsWith('ERROR:')) {
                reject(new Error(result.substring(6)));
            } else {
                resolve(result);
            }
        });
    });
}

// 伺服器本機隊列儲存
function readQueue() {
    try {
        if (fs.existsSync(QUEUE_PATH)) {
            const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('[隊列系統] 讀取 pending queue 失敗:', e.message);
    }
    return [];
}

function saveQueue(queue) {
    try {
        fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf8');
    } catch (e) {
        console.error('[隊列系統] 保存 pending queue 失敗:', e.message);
    }
}

// 背景輪詢：自動消耗未寫入的暫存隊列 (Option 3B: 伺服器端緩衝池)
let queueProcessing = false;
async function processPendingQueue() {
    if (queueProcessing) return;
    const queue = readQueue();
    if (queue.length === 0) return;

    if (checkIsLocked()) {
        console.log(`[隊列系統] 資料庫目前處於避讓鎖定狀態。暫緩寫入，剩餘待寫入筆數: ${queue.length}`);
        return;
    }

    queueProcessing = true;
    console.log(`[隊列系統] 偵測到資料庫解鎖，開始寫入暫存盤點隊列，共計 ${queue.length} 筆...`);

    const remaining = [];
    let successCount = 0;

    for (const item of queue) {
        if (checkIsLocked()) {
            console.warn(`[隊列系統] 寫入中途資料庫再次鎖定。暫停作業。`);
            remaining.push(item);
            continue;
        }

        try {
            const res = await executeAppendTake(item);
            console.log(`[隊列系統] 成功寫入盤點紀錄: ${item.barcode} ➔ 結果: ${res}`);
            successCount++;
        } catch (err) {
            console.error(`[隊列系統] 寫入商品 ${item.barcode} 發生錯誤:`, err.message);
            // 寫入失敗（如非檔案鎖定的格式錯誤），為防止死鎖，予以拋棄並記錄，不阻礙後續隊列
        }
    }

    // 將未完成的重新存回
    saveQueue(remaining);
    queueProcessing = false;
    if (successCount > 0) {
        console.log(`[隊列系統] 批次寫入結束，成功寫入 ${successCount} 筆，剩餘 ${remaining.length} 筆在隊列中。`);
    }
}

// 每 30 秒自動偵測自癒同步一次
setInterval(processPendingQueue, 30000);

// 5. 網頁伺服器主要邏輯
function startWebServer() {
    const server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        // 偵測是否為本機端或區域網路請求
        const remoteIp = req.socket.remoteAddress;
        const host = req.headers.host || '';
        const cleanHost = host.split(':')[0].toLowerCase();
        const isHostAllowed = cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === 'lvh.me' || isPrivateIp(cleanHost);
        const hasForwarded = req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'];
        
        const isLocal = isPrivateIp(remoteIp) && isHostAllowed && !hasForwarded;

        // 安全攔截：設定後台與配置API僅限本機電腦或區域網路電腦開啟
        if (!isLocal && (pathname === '/' || pathname.startsWith('/config') || pathname === '/api/config')) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: 設定後台僅限在本機或區域網路電腦 (http://localhost:3000/config) 開啟。');
            return;
        }

        // 靜態路由重新導向或網頁路由
        if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(302, { 'Location': '/config' });
            res.end();
        } 
        // 1. 設定後台路由
        else if (pathname === '/config' || pathname === '/config.html') {
            serveStaticFile(res, path.join(__dirname, '..', 'public', 'config.html'), 'text/html; charset=utf-8');
        } else if (pathname === '/config.css') {
            serveStaticFile(res, path.join(__dirname, '..', 'public', 'config.css'), 'text/css; charset=utf-8');
        } else if (pathname === '/config.js') {
            serveStaticFile(res, path.join(__dirname, '..', 'public', 'config.js'), 'application/javascript; charset=utf-8');
        }
        // 2. 行動相機與離線盤點網頁路由 (公網可存取)
        else if (pathname === '/scanner' || pathname === '/scanner.html') {
            serveStaticFile(res, path.join(__dirname, '..', 'public', 'scanner.html'), 'text/html; charset=utf-8');
        } else if (pathname === '/inventory' || pathname === '/inventory.html') {
            serveStaticFile(res, path.join(__dirname, '..', 'public', 'inventory.html'), 'text/html; charset=utf-8');
        }

        // API: 讀取設定檔 (限本地)
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
        // API: 寫入設定檔 (限本地)
        else if (pathname === '/api/config' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const parsed = JSON.parse(body);
                    if (!parsed.databasePath) throw new Error('資料庫路徑不可為空');
                    
                    await verifyDatabasePath(parsed.databasePath);
                    
                    if (!parsed.bots || !Array.isArray(parsed.bots)) throw new Error('bots 必須是陣列格式');
                    
                    let oldConfig = {};
                    if (fs.existsSync(CONFIG_PATH)) {
                        try { oldConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
                    }
                    if (parsed.apiToken === '******') {
                        parsed.apiToken = oldConfig.apiToken || '';
                    }
                    if (parsed.bots && oldConfig.bots) {
                        parsed.bots.forEach((bot, idx) => {
                            if (bot.token === '******') {
                                const oldBot = oldConfig.bots[idx];
                                if (oldBot) bot.token = oldBot.token;
                            }
                        });
                    }
                    
                    const tempPath = CONFIG_PATH + '.tmp';
                    fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2), 'utf8');
                    fs.renameSync(tempPath, CONFIG_PATH);
                    
                    console.log('[系統] 設定後台寫入 config.json 成功！');
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
        }
        
        // 🔒 API: 行動盤點上傳資料接口 (開放公網存取，帶金鑰驗證)
        else if (pathname === '/api/take/upload' && req.method === 'POST') {
            const tokenHeader = req.headers['x-api-token'];
            
            // 驗證 API Token (非本機 IP 時強制校驗)
            if (!isLocal && tokenHeader !== activeApiToken) {
                res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '401 Unauthorized: 金鑰憑證不正確。' }));
                return;
            }

            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const item = JSON.parse(body);
                    if (!item.takeNo || !item.barcode || item.qty === undefined) {
                        throw new Error('缺失必要參數 takeNo, barcode 或 qty');
                    }

                    // 🕵️ A. 偵測 ERP 資料庫是否被鎖定中 (避讓雷達)
                    if (checkIsLocked()) {
                        // 📦 觸發 Option 3B: 寫入本機暫存隊列
                        const queue = readQueue();
                        queue.push(item);
                        saveQueue(queue);

                        console.log(`[隊列系統] 偵測到資料庫忙碌，盤點資料已寫入本地暫存隊列。條碼: ${item.barcode}, 數量: ${item.qty}`);
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ success: true, queued: true, message: '目前 ERP 系統商正在進行維護/備份，資料已安全暫存於伺服器。' }));
                        return;
                    }

                    // B. 資料庫暢通 ➔ 直接調用 PowerShell 寫入
                    const result = await executeAppendTake(item);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, queued: false, result: result }));
                    
                    // 寫入成功後，順便嘗試消耗一次之前的 pending queue
                    processPendingQueue().catch(err => console.error('背景排隊寫入失敗:', err.message));

                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: err.message }));
                }
            });
        }
        
        // 🔒 API: 檢查系統鎖定與連線狀態
        else if (pathname === '/api/take/status' && req.method === 'GET') {
            const isLocked = checkIsLocked();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ isLocked: isLocked }));
        }
        
        else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('找不到此頁面');
        }
    });

    // 監聽 0.0.0.0 以允許本機及區域網路 (LAN) 電腦進行管理與配置，安全性由 IP 篩選把關
    server.listen(3000, '0.0.0.0', () => {
        console.log('[系統] 設定網頁伺服器已啟動，監聽 Port 3000 (允許本機與同網域區域網路電腦訪問)。');
        console.log('[系統] 設定後台入口：http://localhost:3000/config');
    });
}

console.log('=============================================');
console.log('        本機設定與行動盤點管理器伺服器       ');
console.log('=============================================');
console.log(`[系統] 正在啟動...`);

loadConfig();
startWebServer();

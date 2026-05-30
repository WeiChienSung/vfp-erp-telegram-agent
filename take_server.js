const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const fsPromises = fs.promises;

const CONFIG_PATH = path.join(__dirname, 'config.json');

/**
 * 非同步檢測檔案是否存在，並支援超時控制，防止 UNC 網路共用磁碟斷線造成主執行緒阻塞。
 * @param {string} filePath - 資料庫檔案路徑
 * @param {number} timeoutMs - 超時限制時間 (毫秒)
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

// 1. 載入設定檔
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

        // 設定後台與配置API僅限本機電腦或區域網路電腦開啟 (防止 Token 外洩)
        if (!isLocal && (pathname === '/' || pathname.startsWith('/config') || pathname === '/api/config')) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: 設定後台僅限在本機或區域網路電腦 (http://localhost:3000/config) 開啟。');
            return;
        }

        // 靜態路由重新導向或網頁路由
        if (pathname === '/' || pathname === '/index.html') {
            // 本地訪問首頁時直接重新導向到設定頁面
            res.writeHead(302, { 'Location': '/config' });
            res.end();
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
            req.on('end', async () => {
                try {
                    const parsed = JSON.parse(body);
                    // 基本結構寫回檢驗
                    if (!parsed.databasePath) throw new Error('資料庫路徑不可為空');
                    
                    // 【安全優化】：非同步安全預檢資料庫路徑，防範 UNC 網路磁碟連線逾時阻塞
                    await verifyDatabasePath(parsed.databasePath);
                    
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
                    
                    // 🛡️ 採用原子寫入 (Write-then-Rename)，防範寫入中途異常斷電導致設定檔損毀
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
        } else {
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
console.log('        本機設定管理器伺服器                 ');
console.log('=============================================');
console.log(`[系統] 正在啟動...`);

loadConfig();
startWebServer();

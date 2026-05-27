const fs = require('fs');
const path = require('path');
const http = require('http');

const CONFIG_PATH = path.join(__dirname, 'config.json');

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

function startWebServer() {
    const server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        // 偵測是否為本機端請求
        const remoteIp = req.socket.remoteAddress;
        const host = req.headers.host || '';
        const cleanHost = host.split(':')[0].toLowerCase();
        const isHostLocal = cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === 'lvh.me';
        const hasForwarded = req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'];
        
        const isLocal = (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') && isHostLocal && !hasForwarded;

        // 設定後台僅限本機電腦開啟
        if (!isLocal) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: 設定後台僅限在本機電腦 (http://localhost:3000/config) 開啟。');
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
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('找不到此頁面');
        }
    });

    // 關鍵！僅監聽 127.0.0.1，防堵任何外網/同網域其他設備存取，確保物理級本地安全
    server.listen(3000, '127.0.0.1', () => {
        console.log('[系統] 本機設定網頁伺服器已啟動，監聽 Port 3000 (限 localhost / 127.0.0.1 訪問)。');
        console.log('[系統] 本機設定後台入口：http://localhost:3000/config');
    });
}

console.log('=============================================');
console.log('        本機設定管理器伺服器                 ');
console.log('=============================================');
console.log(`[系統] 正在啟動...`);

loadConfig();
startWebServer();

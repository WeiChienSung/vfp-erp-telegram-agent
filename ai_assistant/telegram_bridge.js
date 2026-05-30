const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');

const TOKEN = "8964386567:AAFTDXhIFL1N5RZG1-BMVKmFm0PmMhrgSVA"; // agy_messenger_bot
const INBOX_PATH = path.join(__dirname, 'telegram_inbox.txt');
const OUTBOX_PATH = path.join(__dirname, 'telegram_outbox.txt');

// 儲存最後讀取的 message id
const STATE_FILE = path.join(__dirname, 'bridge_state.json');
let lastUpdateId = 0;
if (fs.existsSync(STATE_FILE)) {
    try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        lastUpdateId = state.lastUpdateId || 0;
    } catch(e) {}
}

let chatIds = new Set(); // 所有傳送過訊息的 chatId，用於廣播回覆

// 載入先前的 chatIds
const CHAT_IDS_FILE = path.join(__dirname, 'bridge_chats.json');
if (fs.existsSync(CHAT_IDS_FILE)) {
    try {
        const arr = JSON.parse(fs.readFileSync(CHAT_IDS_FILE, 'utf8'));
        chatIds = new Set(arr);
    } catch(e) {}
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastUpdateId }), 'utf8');
}

function saveChatIds() {
    fs.writeFileSync(CHAT_IDS_FILE, JSON.stringify(Array.from(chatIds)), 'utf8');
}

// 傳送 Telegram 文字訊息
function sendTelegramMessage(chatId, text) {
    const postData = JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
    });

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.error(`[Bridge] Send message failed (HTTP ${res.statusCode}):`, body);
            } else {
                console.log(`[Bridge] Send message success: HTTP 200`);
            }
        });
    });
    req.on('error', (e) => console.error('[Bridge] Send message error:', e.message));
    req.write(postData);
    req.end();
}

// 傳送 Telegram 圖片訊息
function sendTelegramPhoto(chatId, photoPath, caption) {
    if (!fs.existsSync(photoPath)) {
        sendTelegramMessage(chatId, `⚠️ 圖檔不存在: ${photoPath}`);
        return;
    }

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const filename = path.basename(photoPath);

    const postHeader = 
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
        `Content-Type: image/png\r\n\r\n`;

    const postFooter = `\r\n--${boundary}--\r\n`;

    const fileBuffer = fs.readFileSync(photoPath);
    const payload = Buffer.concat([
        Buffer.from(postHeader, 'utf8'),
        fileBuffer,
        Buffer.from(postFooter, 'utf8')
    ]);

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${TOKEN}/sendPhoto`,
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': payload.length
        }
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.error(`[Bridge] Send photo failed (HTTP ${res.statusCode}):`, body);
            } else {
                console.log(`[Bridge] Send photo success: HTTP 200`);
            }
        });
    });
    req.on('error', (e) => console.error('[Bridge] Send photo error:', e.message));
    req.write(payload);
    req.end();
}

// 檔案下載輔助函數 (用於下載 Telegram 圖片/文件)
function downloadTelegramFile(fileId, localPath, callback) {
    const getUrl = `https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`;
    https.get(getUrl, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.ok && data.result && data.result.file_path) {
                    const filePath = data.result.file_path;
                    const downloadUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
                    const fileStream = fs.createWriteStream(localPath);
                    https.get(downloadUrl, (downloadRes) => {
                        downloadRes.pipe(fileStream);
                        fileStream.on('finish', () => {
                            fileStream.close();
                            callback(null, localPath);
                        });
                    }).on('error', (err) => {
                        callback(err);
                    });
                } else {
                    callback(new Error('Failed to get file path from Telegram API'));
                }
            } catch (e) {
                callback(e);
            }
        });
    }).on('error', (err) => {
        callback(err);
    });
}

// 獲取 updates
function getUpdates() {
    const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
    https.get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.ok && data.result) {
                    data.result.forEach((update) => {
                        lastUpdateId = update.update_id;
                        saveState();
                        const msg = update.message;
                        if (!msg) return;

                        const chatId = msg.chat.id;
                        chatIds.add(chatId);
                        saveChatIds();

                        const timestamp = new Date().toISOString();
 
                        // 1. 處理文字訊息
                        if (msg.text) {
                            const line = `[${timestamp}] [Chat:${chatId}] User: ${msg.text}\n`;
                            const cmd = msg.text.trim().toLowerCase();

                            // 1.0 🛡️ 手動暫停與恢復命令
                            if (cmd === '暫停' || cmd === '暫停同步' || cmd === '/pause') {
                                try {
                                    const temp = 'C:\\agy_Add_on\\maintenance_mode.txt.tmp';
                                    fs.writeFileSync(temp, 'manual', 'utf8');
                                    fs.renameSync(temp, 'C:\\agy_Add_on\\maintenance_mode.txt');
                                    sendTelegramMessage(chatId, `⚠️ <b>已手動啟用避讓模式</b>\n\n系統已暫停資料庫同步與價格查詢，確保資料庫安全避讓。`);
                                } catch (err) {
                                    sendTelegramMessage(chatId, `⚠️ <b>啟用避讓模式失敗</b>\n(原因: ${err.message})`);
                                }
                                return;
                            }
                            if (cmd === '開始' || cmd === '開始同步' || cmd === '/resume') {
                                try {
                                    const temp = 'C:\\agy_Add_on\\maintenance_mode.txt.tmp';
                                    fs.writeFileSync(temp, 'false', 'utf8');
                                    fs.renameSync(temp, 'C:\\agy_Add_on\\maintenance_mode.txt');
                                    sendTelegramMessage(chatId, `✅ <b>已關閉避讓模式</b>\n\n系統已恢復正常資料庫同步與價格查詢。`);
                                } catch (err) {
                                    sendTelegramMessage(chatId, `⚠️ <b>關閉避讓模式失敗</b>\n(原因: ${err.message})`);
                                }
                                return;
                            }

                            // 1.1 原生指令處理：截圖 (0 阻礙、0 彈窗)
                            if (cmd === '截圖' || cmd === 'screenshot' || cmd.includes('chrome') || cmd.includes('畫面') || cmd.includes('螢幕')) {
                                sendTelegramMessage(chatId, `📸 <b>收到截圖要求！</b>\n正在擷取您本機的桌面與 Chrome 視窗，請稍候約 3 秒...`);
                                
                                const ps = spawn('powershell.exe', [
                                    '-NoProfile',
                                    '-ExecutionPolicy', 'Bypass',
                                    '-File', path.join(__dirname, 'screenshot.ps1')
                                ]);
                                
                                ps.on('close', (code) => {
                                    // 同時截取 Chrome 局部
                                    const psCrop = spawn('powershell.exe', [
                                        '-NoProfile',
                                        '-ExecutionPolicy', 'Bypass',
                                        '-File', path.join(__dirname, 'crop_screenshot.ps1'),
                                        '-Left', '793', '-Top', '504', '-Width', '814', '-Height', '363',
                                        '-Filename', 'chrome_screenshot.png'
                                    ]);
                                    
                                    psCrop.on('close', (codeCrop) => {
                                        const chromePath = 'C:\\Users\\5Vce8\\.gemini\\antigravity\\brain\\c871c3ab-b241-4c32-9151-f72ab4cf2c5a\\chrome_screenshot.png';
                                        const fullPath = 'C:\\Users\\5Vce8\\.gemini\\antigravity\\brain\\c871c3ab-b241-4c32-9151-f72ab4cf2c5a\\desktop_screenshot.png';
                                        
                                        sendTelegramMessage(chatId, `<b>Chrome 視窗局部畫面：</b>`);
                                        sendTelegramPhoto(chatId, chromePath, `Chrome 視窗`);
                                        sendTelegramMessage(chatId, `<b>完整桌面螢幕畫面：</b>`);
                                        sendTelegramPhoto(chatId, fullPath, `完整螢幕`);
                                    });
                                });
                                return;
                            }
 
                            // 1.2 原生指令處理：讀取日誌
                            if (cmd === '日誌' || cmd === 'logs' || cmd.includes('log') || cmd.includes('日誌')) {
                                sendTelegramMessage(chatId, `📝 <b>正在讀取 take_server.js 的最新日誌...</b>`);
                                const logPath = 'C:\\agy_Add_on\\take_server.log';
                                try {
                                    if (fs.existsSync(logPath)) {
                                        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
                                        const lastLines = lines.slice(-25).join('\n');
                                        sendTelegramMessage(chatId, `📝 <b>take_server.log 最後 25 行：</b>\n<pre>${lastLines || '日誌內容為空'}</pre>`);
                                    } else {
                                        sendTelegramMessage(chatId, `⚠️ 找不到日誌檔案: ${logPath}`);
                                    }
                                } catch (e) {
                                    sendTelegramMessage(chatId, `⚠️ 讀取日誌失敗: ${e.message}`);
                                }
                                return;
                            }
 
                            // 1.3 原生指令處理：重啟服務 (直接在背景調用，不引發 YES/NO 彈窗)
                            if (cmd === '重啟' || cmd === 'restart' || cmd === '重啟服務') {
                                sendTelegramMessage(chatId, `🔄 <b>正在重啟 ERP 盤點與 Bot 服務...</b>\n這將在本機背景殺死進程並重新連線，大約需要 15 秒...`);
                                
                                const ps = spawn('powershell.exe', [
                                    '-NoProfile',
                                    '-ExecutionPolicy', 'Bypass',
                                    '-File', path.join(__dirname, 'restart_services.ps1')
                                ]);
                                
                                ps.stdout.on('data', (data) => console.log('[Restart Script]', data.toString().trim()));
                                
                                ps.on('close', (code) => {
                                    if (code === 0) {
                                        // 讀取新的網址並傳給使用者
                                        setTimeout(() => {
                                            const activeUrlFile = 'C:\\agy_Add_on\\active_url.txt';
                                            if (fs.existsSync(activeUrlFile)) {
                                                const newUrl = fs.readFileSync(activeUrlFile, 'utf8').trim();
                                                sendTelegramMessage(chatId, `✅ <b>ERP 服務已重啟完畢！</b>\n\n🔗 <b>最新盤點連結：</b>\n${newUrl}`);
                                            } else {
                                                sendTelegramMessage(chatId, `✅ <b>服務重啟成功，但尚未產生新的外網連結。</b>\n請稍候 5 秒在 Telegram 輸入「盤點」獲取。`);
                                            }
                                        }, 3000); // 稍等 3 秒讓 localtunnel 分配網址
                                    } else {
                                        sendTelegramMessage(chatId, `⚠️ 服務重啟腳本退出，代碼: ${code}`);
                                    }
                                });
                                return;
                            }
 
                            // 1.4 原生指令處理：關機與取消關機 (遠端遙控 Windows 關機)
                            if (cmd === '關機' || cmd === 'shutdown' || cmd.includes('關電腦') || cmd.includes('關機')) {
                                sendTelegramMessage(chatId, `🖥️ <b>收到關機要求！</b>\n系統已啟動 Windows 關機排程（將於 30 秒後關閉本機電腦）。\n\n若需取消關機，請立刻在 Telegram 輸入：\n<code>取消關機</code> 或 <code>abort</code>`);
                                spawn('shutdown.exe', ['/s', '/t', '30', '/c', 'Telegram Bridge Requested Shutdown']);
                                return;
                            }
 
                            if (cmd === '取消關機' || cmd === 'abort' || cmd.includes('取消關機')) {
                                sendTelegramMessage(chatId, `✅ <b>已成功取消 Windows 關機排程！</b>`);
                                spawn('shutdown.exe', ['/a']);
                                return;
                            }
 
                            // 1.5 其他一般文字，寫入 Inbox
                            fs.appendFileSync(INBOX_PATH, line, 'utf8');
                            console.log(`[Bridge Inbox] ${line.trim()}`);
                        }
                        // 2. 處理圖片訊息 (Photo)
                        else if (msg.photo && msg.photo.length > 0) {
                            const photo = msg.photo[msg.photo.length - 1]; // 獲取最大尺寸的圖片
                            const fileId = photo.file_id;
                            const downloadsDir = path.join(__dirname, 'downloads');
                            if (!fs.existsSync(downloadsDir)) {
                                fs.mkdirSync(downloadsDir, { recursive: true });
                            }
                            const filename = `photo_${Date.now()}.jpg`;
                            const localPath = path.join(downloadsDir, filename);

                            sendTelegramMessage(chatId, `📥 <b>收到圖片！</b>\n正在為您下載並提交給 AI 分析，請稍候約 5 秒...`);

                            downloadTelegramFile(fileId, localPath, (err, savedPath) => {
                                if (err) {
                                    console.error('[Bridge] Download photo error:', err.message);
                                    sendTelegramMessage(chatId, `⚠️ 圖片下載失敗: ${err.message}`);
                                    return;
                                }
                                const captionText = msg.caption ? ` (附註說明: ${msg.caption})` : '';
                                const line = `[${timestamp}] [Chat:${chatId}] User sent photo: ${savedPath}${captionText}\n`;
                                fs.appendFileSync(INBOX_PATH, line, 'utf8');
                                console.log(`[Bridge Inbox] ${line.trim()}`);
                                sendTelegramMessage(chatId, `✅ <b>圖片下載成功！</b>\n已將圖片提交給 AI。您現在可以在網頁對話框中與我討論這張圖片了！`);
                            });
                        }
                    });
                }
            } catch (e) {
                console.error('[Bridge] Parse update error:', e.message);
            }
            // 繼續 polling
            setTimeout(getUpdates, 1000);
        });
    }).on('error', (e) => {
        console.error('[Bridge] Polling error:', e.message);
        setTimeout(getUpdates, 5000);
    });
}

// 監聽 Outbox 變更
let isProcessingOutbox = false;
function checkOutbox() {
    if (isProcessingOutbox) return;
    if (!fs.existsSync(OUTBOX_PATH)) return;

    isProcessingOutbox = true;
    try {
        const raw = fs.readFileSync(OUTBOX_PATH, 'utf8').trim();
        if (raw) {
            // 清空 outbox 檔案，防重複發送
            fs.writeFileSync(OUTBOX_PATH, '', 'utf8');

            console.log(`[Bridge Outbox] 發送回覆至 ${chatIds.size} 個會話...`);
            
            // 支援圖片傳送標記：格式 [[PHOTO:C:\path\to\img.png]]
            const photoRegex = /\[\[PHOTO:(.+?)\]\]/g;
            let match;
            let photosToSend = [];
            let cleanText = raw;

            while ((match = photoRegex.exec(raw)) !== null) {
                photosToSend.push(match[1]);
                cleanText = cleanText.replace(match[0], '');
            }
            cleanText = cleanText.trim();

            chatIds.forEach((chatId) => {
                if (cleanText) {
                    sendTelegramMessage(chatId, cleanText);
                }
                photosToSend.forEach((photoPath) => {
                    sendTelegramPhoto(chatId, photoPath, "實時截圖畫面");
                });
            });
        }
    } catch (e) {
        console.error('[Bridge] Process outbox error:', e.message);
    } finally {
        isProcessingOutbox = false;
    }
}

// 用 fs.watch 監控 Outbox
if (!fs.existsSync(OUTBOX_PATH)) {
    fs.writeFileSync(OUTBOX_PATH, '', 'utf8');
}
fs.watch(OUTBOX_PATH, (event, filename) => {
    if (event === 'change') {
        checkOutbox();
    }
});
const MONITOR_CONFIG = {
    maintenanceFile: 'C:\\agy_Add_on\\maintenance_mode.txt',
    checkIntervalMs: 10000, // 10秒輪詢一次
    execTimeoutMs: 4000,    // 4秒超時
    anydeskLogPaths: [
        'C:\\Users\\5Vce8\\AppData\\Roaming\\AnyDesk\\ad.trace',
        'C:\\ProgramData\\AnyDesk\\ad.trace'
    ],
    nasLocksDir: '\\\\192.168.1.99\\d\\nmedi\\locks',
    tailReadBytes: 8192,
    remoteProcesses: [
        'anydesk.exe',
        'teamviewer.exe',
        'teamviewer_service.exe',
        'tv_w32.exe',
        'remoting_host.exe',
        'rustdesk.exe',
        'ultraviewer_desktop.exe',
        'sunloginclient.exe',
        'sunloginclient_desktop.exe',
        'todesk.exe',
        'todesk_service.exe',
        'winvnc.exe',
        'tvnserver.exe',
        'ammyy.exe',
        'supremo.exe'
    ]
};

// 安全執行指令，帶超時控制
function runSystemCommand(cmd, args, timeoutMs = MONITOR_CONFIG.execTimeoutMs) {
    return new Promise((resolve, reject) => {
        let isSettled = false;
        const child = spawn(cmd, args);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        const timer = setTimeout(() => {
            if (!isSettled) {
                isSettled = true;
                child.kill('SIGKILL');
                reject(new Error(`Command ${cmd} timed out`));
            }
        }, timeoutMs);
        child.on('close', (code) => {
            clearTimeout(timer);
            if (!isSettled) {
                isSettled = true;
                if (code === 0) resolve(stdout);
                else reject(new Error(`Exited with ${code}: ${stderr}`));
            }
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            if (!isSettled) {
                isSettled = true;
                reject(err);
            }
        });
    });
}

// 檢測是否有活躍的 RDP 連線
async function checkActiveRdpSession() {
    try {
        const output = await runSystemCommand('query.exe', ['session']);
        const lines = output.toLowerCase().split('\n');
        for (const line of lines) {
            if (line.includes('rdp-tcp') && line.includes('active')) {
                return true;
            }
        }
        return false;
    } catch (err) {
        try {
            const netstatOut = await runSystemCommand('netstat.exe', ['-ano']);
            return netstatOut.toLowerCase().includes(':3389') && netstatOut.toLowerCase().includes('established');
        } catch (e) {
            return false;
        }
    }
}

// 檢測 AnyDesk 進程數
async function checkAnydeskProcessCount() {
    try {
        const output = await runSystemCommand('tasklist.exe', ['/NH', '/FI', 'IMAGENAME eq anydesk.exe']);
        const matches = output.match(/anydesk\.exe/gi);
        const count = matches ? matches.length : 0;
        return count >= 3;
    } catch (err) {
        return false;
    }
}

// 解析 AnyDesk 日誌檔尾端
function checkAnydeskLogForActiveSession(filePath) {
    let fd = null;
    try {
        if (!fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (stat.size === 0) return false;
        fd = fs.openSync(filePath, 'r');
        const readLength = Math.min(stat.size, MONITOR_CONFIG.tailReadBytes);
        const position = stat.size - readLength;
        const buffer = Buffer.alloc(readLength);
        fs.readSync(fd, buffer, 0, readLength, position);
        const logContent = buffer.toString('utf8');
        const lines = logContent.split(/\r?\n/).reverse();
        for (const line of lines) {
            if (line.includes('app.backend_session - Session started')) {
                return true;
            }
            if (line.includes('app.backend_session - Session stopped') || 
                line.includes('Session closed by remote side') ||
                line.includes('app.backend_session - Session closed')) {
                return false;
            }
        }
    } catch (err) {
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (e) {}
        }
    }
    return false;
}

// 檢測 NAS 上的分機鎖定檔
function checkNasDistributedLocks() {
    if (!fs.existsSync(MONITOR_CONFIG.nasLocksDir)) return false;
    try {
        const files = fs.readdirSync(MONITOR_CONFIG.nasLocksDir);
        const now = Date.now();
        for (const file of files) {
            if (file.endsWith('.lock')) {
                const filePath = path.join(MONITOR_CONFIG.nasLocksDir, file);
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs < 30000) {
                    return true;
                }
            }
        }
    } catch (e) {}
    return false;
}

// 原子寫入維護模式標記
function updateMaintenanceState(state) {
    try {
        if (fs.existsSync(MONITOR_CONFIG.maintenanceFile)) {
            const current = fs.readFileSync(MONITOR_CONFIG.maintenanceFile, 'utf8').trim();
            if (current === 'manual' && state !== 'false') {
                return;
            }
        }
        const temp = MONITOR_CONFIG.maintenanceFile + '.tmp';
        fs.writeFileSync(temp, state, 'utf8');
        fs.renameSync(temp, MONITOR_CONFIG.maintenanceFile);
    } catch (e) {
        console.error(`[避讓監控] 寫入避讓檔案失敗: ${e.message}`);
    }
}

// 避讓監控主循環
async function monitorLoop() {
    try {
        let isManual = false;
        if (fs.existsSync(MONITOR_CONFIG.maintenanceFile)) {
            const current = fs.readFileSync(MONITOR_CONFIG.maintenanceFile, 'utf8').trim();
            isManual = (current === 'manual');
        }

        if (!isManual) {
            const hasRdp = await checkActiveRdpSession();
            let hasAnydeskSession = false;
            for (const logPath of MONITOR_CONFIG.anydeskLogPaths) {
                if (checkAnydeskLogForActiveSession(logPath)) {
                    hasAnydeskSession = true;
                    break;
                }
            }
            let hasAnydeskProc = false;
            if (!hasAnydeskSession) {
                hasAnydeskProc = await checkAnydeskProcessCount();
            }
            const hasNasLock = checkNasDistributedLocks();
            
            const isRemoteActive = hasRdp || hasAnydeskSession || hasAnydeskProc || hasNasLock;
            
            if (isRemoteActive) {
                updateMaintenanceState('remote');
            } else {
                updateMaintenanceState('false');
            }
        }
    } catch (err) {
        console.error(`[避讓監控] 錯誤: ${err.message}`);
    } finally {
        setTimeout(monitorLoop, MONITOR_CONFIG.checkIntervalMs);
    }
}

// 啟動自癒：重置 stale 狀態
if (fs.existsSync(MONITOR_CONFIG.maintenanceFile)) {
    try {
        const current = fs.readFileSync(MONITOR_CONFIG.maintenanceFile, 'utf8').trim();
        if (current === 'remote' || current === 'true') {
            updateMaintenanceState('false');
        }
    } catch (e) {}
}

// 啟動
console.log('=============================================');
console.log('      Antigravity Telegram Bridge 啟動      ');
console.log(`      連線 Bot: @agy_messenger_bot   `);
console.log('=============================================');
checkOutbox();
getUpdates();
monitorLoop();

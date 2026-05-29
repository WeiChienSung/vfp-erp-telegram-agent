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
                        if (msg && msg.text) {
                            const chatId = msg.chat.id;
                            chatIds.add(chatId);
                            saveChatIds();
 
                            const timestamp = new Date().toISOString();
                            const line = `[${timestamp}] [Chat:${chatId}] User: ${msg.text}\n`;
                            const cmd = msg.text.trim().toLowerCase();
 
                            // 1. 原生指令處理：截圖 (0 阻礙、0 彈窗)
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
 
                            // 2. 原生指令處理：讀取日誌
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
 
                            // 3. 原生指令處理：重啟服務 (直接在背景調用，不引發 YES/NO 彈窗)
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
 
                            // 4. 其他一般指令，寫入 Inbox 提交給 AI
                            fs.appendFileSync(INBOX_PATH, line, 'utf8');
                            console.log(`[Bridge Inbox] ${line.trim()}`);
                            sendTelegramMessage(chatId, `📥 <b>已收到指令！</b>\n已將指令提交給 Antigravity (AI 助理)，將在 60 秒內為您處理，請稍候...`);
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
// 啟動
console.log('=============================================');
console.log('      Antigravity Telegram Bridge 啟動      ');
console.log(`      連線 Bot: @agy_messenger_bot   `);
console.log('=============================================');
checkOutbox();
getUpdates();

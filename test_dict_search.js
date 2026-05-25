const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(raw);

const dbPath = config.databasePath;

function readStockDb(dbPath, keyword) {
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

        fields.push({ name, type, length: len, offset: currentRecordOffset });
        currentRecordOffset += len;
        offset += 32;
    }

    const big5Decoder = new TextDecoder('big5');
    const results = [];

    for (let r = 0; r < recordCount; r++) {
        const filePos = headerLength + (r * recordLength);
        if (fileBuffer[filePos] === 0x2A) continue;

        const recordBuf = fileBuffer.subarray(filePos, filePos + recordLength);
        const record = {};
        const targetFields = ['NO', 'NAME', 'BNO', 'BNO1', 'BNO2'];
        
        for (const f of fields) {
            if (targetFields.includes(f.name)) {
                const rawVal = recordBuf.subarray(f.offset, f.offset + f.length);
                let end = rawVal.length;
                while (end > 0 && (rawVal[end - 1] === 0x20 || rawVal[end - 1] === 0x00)) end--;
                record[f.name] = big5Decoder.decode(rawVal.subarray(0, end));
            }
        }

        if (!record['NO']) continue;
        if (record['NAME']) record['NAME'] = record['NAME'].replace(/\*+$/, '').trim();

        const nameStr = record['NAME'] || '';
        
        if (keyword) {
            let normalizedKeyword = keyword.trim().toLowerCase()
                .replace(/([\u4e00-\u9fa5])([^\u4e00-\u9fa5\s　])/g, '$1 $2')
                .replace(/([^\u4e00-\u9fa5\s　])([\u4e00-\u9fa5])/g, '$1 $2');

            // Dictionary-assisted splitting
            const COMMON_WORDS = [
                "華新", "中衛", "勤達", "佳合", "好貼", "卡好", "優生", "喜多", "貝瑞克", 
                "舒美", "康乃馨", "成威", "康盟", "中興", "博朗", "歐姆龍", "羅氏", "泰爾茂", 
                "百略", "福爾", "魚躍", "yasco", "3m",
                "大白", "紙膠", "口罩", "酒精", "拔罐", "針灸", "棉棒", "紗布", "繃帶", 
                "手套", "針頭", "針灸針", "生理食鹽水", "生理", "食鹽水", "凡士林", "血糖", 
                "奶瓶", "奶嘴", "熱水袋", "冰袋", "輪椅", "拐杖", "便器椅", "洗澡椅", 
                "護膝", "護肘", "護腕", "護腰", "網狀", "彈性袜", "彈性襪", "化工", "玻璃", 
                "檢診", "彈性"
            ];

            for (const word of COMMON_WORDS) {
                if (normalizedKeyword.includes(word)) {
                    normalizedKeyword = normalizedKeyword.split(word).join(' ' + word + ' ');
                }
            }

            const queryKeywords = normalizedKeyword.split(/[\s　]+/).filter(Boolean);
            
            const matchesAll = queryKeywords.every(kw => {
                const matchesNo = record['NO'].toLowerCase().includes(kw);
                const matchesName = nameStr.toLowerCase().includes(kw);
                const matchesBarcode = (record['BNO'] || '').toLowerCase().includes(kw) || 
                                       (record['BNO1'] || '').toLowerCase().includes(kw);
                return matchesNo || matchesName || matchesBarcode;
            });

            if (matchesAll) {
                record.matchedKeywords = queryKeywords;
                results.push(record);
            }
        } else {
            results.push(record);
        }
    }
    return results;
}

try {
    const results = readStockDb(dbPath, "華新大白");
    console.log(`Results for '華新大白':`);
    results.forEach(r => {
        console.log(`- NO: [${r.NO}] NAME: [${r.NAME}] Matched:`, r.matchedKeywords);
    });
} catch (e) {
    console.error("Error:", e.message);
}

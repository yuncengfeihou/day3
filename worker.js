// 文件: public/extensions/third-party/day3/worker.js
// (在 index.js 中引用时路径为 'scripts/extensions/third-party/day3/worker.js')

const DB_NAME = 'SillyTavernDay1Stats';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1; // 确保这个版本号和 index.js 中的一致
let db; // 用于缓存数据库连接

// --- IndexedDB 辅助函数 ---

/**
 * 打开或返回已打开的 IndexedDB 数据库连接。
 * 注意：此函数不再处理数据库升级或对象存储创建，这由主线程负责。
 */
function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }
        console.log("Day1 Worker: Attempting to open IndexedDB...");
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => {
            console.error('Day1 Worker: IndexedDB open error:', event.target.error);
            reject('IndexedDB error: ' + event.target.error);
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Day1 Worker: IndexedDB connection opened successfully.');
            db.onerror = (event) => console.error("Day1 Worker: Database error:", event.target.error);
            db.onclose = () => { console.log("Day1 Worker: Database connection closed."); db = null; };
            db.onversionchange = () => { console.log("Day1 Worker: Database version change detected, closing connection."); if (db) { db.close(); db = null; } };
            resolve(db);
        };
    });
}

/**
 * 从指定的对象存储中读取特定 ID 的数据。
 * @param {string} entityId 要读取数据的实体 ID (主键)。
 * @returns {Promise<object|undefined>} 返回找到的数据对象，如果未找到则返回 undefined。
 */
function readData(entityId) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(entityId);
            request.onerror = (event) => reject('Error reading data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result);
        } catch (error) {
            console.error("Day1 Worker: Error during readData transaction setup:", error);
            reject(error);
        }
    });
}

/**
 * 将数据写入（或更新）到指定的对象存储中。
 * @param {object} data 要写入的数据对象，必须包含 keyPath ('entityId')。
 * @returns {Promise<IDBValidKey>} 写入成功时返回写入记录的主键。
 */
function writeData(data) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data);
            request.onerror = (event) => reject('Error writing data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result);
        } catch (error) {
            console.error("Day1 Worker: Error during writeData transaction setup:", error);
            reject(error);
        }
    });
}

/**
 * 获取或初始化指定日期的统计数据对象。
 * @param {object} stats - 整个实体的统计对象。
 * @param {string} dateString - YYYY-MM-DD 格式的日期字符串。
 * @returns {object} 当天的统计数据对象。
 */
function getOrCreateDailyStat(stats, dateString) {
    if (!stats.dailyData) {
        stats.dailyData = {};
    }
    if (!stats.dailyData[dateString]) {
        stats.dailyData[dateString] = {
            userMessages: 0,
            aiMessages: 0,
            userTokens: 0,       // 新增：用户消息 Token 总和
            aiTokens: 0,         // 新增：AI 消息 Token 总和
            cumulativeTokens: 0, // 含义改变：累计 Prompt Token 总和
        };
        console.log(`Day1 Worker: Creating new daily entry for ${stats.entityId} on ${dateString}`);
    }
    // 确保新字段存在于旧记录中
    stats.dailyData[dateString].userTokens = stats.dailyData[dateString].userTokens || 0;
    stats.dailyData[dateString].aiTokens = stats.dailyData[dateString].aiTokens || 0;
    stats.dailyData[dateString].cumulativeTokens = stats.dailyData[dateString].cumulativeTokens || 0; // 保留（但含义已变）或重新初始化

    return stats.dailyData[dateString];
}


// --- Web Worker 消息处理 ---
self.onmessage = async (event) => {
    if (!event.data || !event.data.command) {
        console.warn("Day1 Worker: Received invalid message format.");
        return;
    }

    const { command, payload } = event.data;

    // 处理 'processMessage' 命令：记录单条消息的计数和 Token
    if (command === 'processMessage') {
        if (!payload || !payload.entityId || !payload.timestamp) {
             console.warn('Day1 Worker: Received processMessage command with missing payload data.', payload);
             return;
        }
        const { entityId, entityName, isUser, tokenCount, timestamp } = payload;

        try {
            let date;
            try {
                date = new Date(timestamp);
                if (isNaN(date.getTime())) { date = new Date(); }
            } catch (e) { date = new Date(); }
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            if (!stats) {
                stats = {
                    entityId: entityId,
                    entityName: entityName || entityId,
                    dailyData: {},
                };
            }
            // 更新实体名称
            if (entityName && stats.entityName !== entityName) {
                stats.entityName = entityName;
            }

            // 获取或创建当天的统计对象
            const dailyStat = getOrCreateDailyStat(stats, dateString);

            // 更新消息计数和对应的 Token 计数
            if (isUser === true) {
                dailyStat.userMessages += 1;
                dailyStat.userTokens += Number(tokenCount) || 0; // 累加用户 Token
            } else if (isUser === false) {
                dailyStat.aiMessages += 1;
                dailyStat.aiTokens += Number(tokenCount) || 0; // 累加 AI Token
            }

            // 不再在此处更新 cumulativeTokens

            await writeData(stats);

        } catch (error) {
            console.error(`Day1 Worker: Error processing message for entity ${entityId}:`, error);
        }
    }
    // 处理 'recordPromptTokens' 命令：记录每次发送给 API 的总 Prompt Token
    else if (command === 'recordPromptTokens') {
        if (!payload || !payload.entityId || !payload.timestamp || typeof payload.promptTokenCount !== 'number') {
            console.warn('Day1 Worker: Received recordPromptTokens command with missing payload data.', payload);
            return;
        }
        const { entityId, entityName, timestamp, promptTokenCount } = payload;

         try {
            let date;
            try {
                date = new Date(timestamp);
                if (isNaN(date.getTime())) { date = new Date(); }
            } catch (e) { date = new Date(); }
            const dateString = date.toISOString().split('T')[0];

            let stats = await readData(entityId);
            if (!stats) {
                stats = {
                    entityId: entityId,
                    entityName: entityName || entityId,
                    dailyData: {},
                };
            }
            // 更新实体名称
            if (entityName && stats.entityName !== entityName) {
                stats.entityName = entityName;
            }

            // 获取或创建当天的统计对象
            const dailyStat = getOrCreateDailyStat(stats, dateString);

            // 累加 Prompt Token 到 cumulativeTokens
            dailyStat.cumulativeTokens += Number(promptTokenCount) || 0;
            console.log(`Day1 Worker: Recorded ${promptTokenCount} prompt tokens for ${entityId} on ${dateString}. New total: ${dailyStat.cumulativeTokens}`);

            await writeData(stats);

        } catch (error) {
            console.error(`Day1 Worker: Error recording prompt tokens for entity ${entityId}:`, error);
        }
    }
};

// --- Worker 初始化 ---
console.log('Day1 Worker: Script loaded and initializing.');
openDB().then(() => {
    console.log("Day1 Worker: Initial DB connection attempt successful.");
}).catch(e => {
    console.error("Day1 Worker: Initial DB connection attempt failed.", e);
});

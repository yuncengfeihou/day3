// 文件: public/extensions/third-party/day2/index.js

import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
// 注意：确保下面这行的路径对于你的 SillyTavern 版本是正确的
// 如果 script.js 在根目录，通常是 '../../../../script.js'
// 如果 script.js 在 /src/ 目录，可能是 '../../../../src/script.js'
import { saveSettingsDebounced, eventSource, event_types, mainApi, power_user } from '../../../../script.js';
// 注意： getTokenCountAsync 通常在 tokenizers.js 中
import { getTokenCountAsync } from '../../../../tokenizers.js'; // 确保路径正确


(function () {
    // --- 插件基础信息 ---
    const extensionName = "day2";
    const pluginFolderName = "day2"; // 与你的文件夹名称匹配
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`;
    const extensionSettings = extension_settings[extensionName] || {};
    const defaultSettings = {};

    // --- 插件状态变量 ---
    let day1Worker;
    let currentEntityId = null;
    let currentEntityName = null;
    // **新增：用于追踪待确认消耗的 Prompt Token 的状态变量**
    let lastCalculatedPromptTokens = 0;
    let lastUsedApi = ''; // 记录计算时使用的 API 类型
    let pendingTokenConsumptionLog = false; // 关键标志位，true表示已预计算Token，等待API成功响应

    // --- IndexedDB 相关 ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;

    function openDBMain() {
        return new Promise((resolve, reject) => {
            if (dbInstance) { resolve(dbInstance); return; }
            console.log(`[${extensionName}] Main: Attempting to open IndexedDB...`);
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = (event) => { console.error(`[${extensionName}] Main: IndexedDB open error:`, event.target.error); reject('IndexedDB error: ' + event.target.error); };
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                console.log(`[${extensionName}] Main: IndexedDB connection opened successfully.`);
                dbInstance.onerror = (event) => console.error(`[${extensionName}] Main: Database error:`, event.target.error);
                dbInstance.onclose = () => { console.log(`[${extensionName}] Main: Database connection closed.`); dbInstance = null; };
                dbInstance.onversionchange = () => { console.log(`[${extensionName}] Main: Database version change detected, closing connection.`); if (dbInstance) { dbInstance.close(); dbInstance = null; } };
                resolve(dbInstance);
            };
            request.onupgradeneeded = (event) => {
                console.log(`[${extensionName}] Main: IndexedDB upgrade needed.`);
                const db = event.target.result;
                const transaction = event.target.transaction;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    try {
                        db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                        console.log(`[${extensionName}] Main: Object store "${STORE_NAME}" created.`);
                    } catch (e) {
                         console.error(`[${extensionName}] Main: Error creating object store "${STORE_NAME}"`, e);
                         if (transaction) transaction.abort();
                         reject(`Error creating object store: ${e}`);
                         return;
                    }
                }
                console.log(`[${extensionName}] Main: IndexedDB upgrade finished.`);
            };
        });
    }

    function getAllStats() {
        return new Promise(async (resolve, reject) => {
            try {
                const db = await openDBMain();
                const transaction = db.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.getAll();
                request.onerror = (event) => reject('Error reading all data: ' + event.target.error);
                request.onsuccess = (event) => resolve(event.target.result || []);
            } catch (error) {
                console.error(`[${extensionName}] Main: Error during getAllStats:`, error);
                reject(error);
            }
        });
    }

    // --- Worker 通信 ---
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) { console.error(`[${extensionName}] Main: Worker not initialized! Cannot send message.`); return; }
        try {
             day1Worker.postMessage({ command, payload });
        } catch (error) {
             console.error(`[${extensionName}] Main: Error posting message to worker:`, error, { command, payload });
        }
    }

    // --- UI 更新 ---
    async function updateStatsTable() {
        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) { /* console.warn(`[${extensionName}] Main: Stats table body not found in DOM.`); */ return; }
        tableBody.empty().append('<tr><td colspan="5"><i>正在加载统计数据...</i></td></tr>');

        try {
            const allStats = await getAllStats();
            const todayString = new Date().toISOString().split('T')[0];
            tableBody.empty();

            if (allStats.length === 0) {
                tableBody.append('<tr><td colspan="5"><i>暂无任何统计数据。</i></td></tr>');
                return;
            }

            let hasTodayData = false;
            allStats.sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            allStats.forEach(entityStats => {
                const dailyData = entityStats.dailyData ? entityStats.dailyData[todayString] : null;
                if (dailyData) {
                    hasTodayData = true;
                    // 行格式现在包含所有四个计数器
                    const row = `
                        <tr>
                            <td>${entityStats.entityName || entityStats.entityId}</td>
                            <td>${dailyData.userMessages || 0} (${dailyData.userTokens || 0} tk)</td>
                            <td>${dailyData.aiMessages || 0} (${dailyData.aiTokens || 0} tk)</td>
                            <td>${dailyData.cumulativeTokens || 0}</td>
                            <td>${todayString}</td>
                        </tr>
                    `;
                    tableBody.append(row);
                }
            });

            if (!hasTodayData) {
                 tableBody.append(`<tr><td colspan="5"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`);
            }

        } catch (error) {
            console.error(`[${extensionName}] Main: Error fetching or updating stats table:`, error);
            tableBody.empty().append('<tr><td colspan="5"><i style="color: red;">加载统计数据失败，请检查控制台。</i></td></tr>');
        }
    }

    // --- 事件处理 ---

    /**
     * 处理单条消息（用户或 AI），计算 Token 并发送给 Worker 进行记录。
     * @param {object} message SillyTavern 的消息对象。
     * @param {boolean} isUser 标记消息是否由用户发送。
     */
    async function handleMessage(message, isUser) {
        // 确保有当前实体 ID 才能记录
        if (!message || !currentEntityId) {
            // console.log(`[${extensionName}] handleMessage: Skipping, no message or currentEntityId (${currentEntityId})`);
            return;
        }

        let tokenCount = 0;
        try {
            // 优先使用消息自带的 token_count (如果存在且有效)
            if (typeof message?.extra?.token_count === 'number' && message.extra.token_count > 0) {
                tokenCount = message.extra.token_count;
                 // console.log(`[${extensionName}] handleMessage: Using pre-calculated token count: ${tokenCount}`);
            } else if (message.mes) {
                // 否则，使用 getTokenCountAsync 计算
                tokenCount = await getTokenCountAsync(message.mes || '', 0); // 确保 getTokenCountAsync 可用
                 // console.log(`[${extensionName}] handleMessage: Calculated token count: ${tokenCount}`);
            }
        } catch (err) {
            console.warn(`[${extensionName}] Main: Failed to get token count for message, estimating...`, err);
            // 降级方案：简单估计
            tokenCount = Math.round((message.mes || '').length / 3.5);
        }

        const payload = {
            entityId: currentEntityId,
            entityName: currentEntityName, // 发送当前实体名称
            isUser: isUser,
            tokenCount: tokenCount,
            timestamp: message.send_date || Date.now(), // 使用消息发送时间或当前时间
        };
        // console.log(`[${extensionName}] handleMessage: Sending 'processMessage' to worker:`, payload);
        sendMessageToWorker('processMessage', payload);
    }

    // **移除：** 不再需要 handlePromptBuilt 函数，因为监听的事件变了
    // async function handlePromptBuilt(eventData) { ... }

    /**
     * 处理用户发送的消息 (MESSAGE_SENT 事件)
     */
    function onMessageSent(messageId) {
        const context = getContext();
        if (!context || !context.chat || !context.chat[messageId]) return;
        const message = context.chat[messageId];
        // console.log(`[${extensionName}] onMessageSent triggered for ID: ${messageId}`);
        handleMessage(message, true); // 用户消息 isUser = true
    }

    // **修改：** 原 onMessageReceived 函数不再需要，其逻辑合并到新的 MESSAGE_RECEIVED 监听器中
    // function onMessageReceived(messageId) { ... }

    /**
     * 处理聊天上下文变化 (CHAT_CHANGED 事件)
     */
    function onChatChanged(chatId) {
        const context = getContext();
        if (!context) {
            currentEntityId = null;
            currentEntityName = null;
            console.log(`[${extensionName}] Main: Chat context cleared.`);
            return;
        }

        let newEntityId = null;
        let newEntityName = null;

        if (context.groupId !== undefined && context.groupId !== null) {
            newEntityId = String(context.groupId); // 确保是字符串 ID
            newEntityName = context.groups?.find(g => String(g.id) === newEntityId)?.name || newEntityId;
        } else if (context.characterId !== undefined && context.characterId !== null && context.characters && context.characters[context.characterId]) {
            // 使用 character 的 avatar 作为 ID，因为它通常是文件名，比内部索引更稳定
            newEntityId = context.characters[context.characterId].avatar;
            newEntityName = context.characters[context.characterId].name;
        }

        if (newEntityId !== currentEntityId) {
            currentEntityId = newEntityId;
            currentEntityName = newEntityName;
            console.log(`[${extensionName}] Main: Chat context changed. Current entity: ${currentEntityName || 'None'} (ID: ${currentEntityId || 'None'})`);
            // 可以在这里重置与特定聊天相关的状态（如果需要）
            pendingTokenConsumptionLog = false; // 切换聊天时，重置待处理的 token 标记
            lastCalculatedPromptTokens = 0;
            lastUsedApi = '';
        }
    }

    // --- 插件初始化 ---
    jQuery(async () => {
        console.log(`[${extensionName}] Main: Initializing extension...`);
        // 加载或设置默认设置
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });

        // 初始化 IndexedDB
        try {
            await openDBMain();
            console.log(`[${extensionName}] Main: Initial DB connection/setup successful.`);
        } catch (error) {
            console.error(`[${extensionName}] Main: Critical - Failed initial DB open/setup:`, error);
            // 可以考虑添加一个用户可见的错误提示
            // alert("Day2 插件数据库初始化失败，统计功能可能无法正常工作。请检查浏览器控制台获取详细信息。");
        }

        // 注入设置 UI
        try {
            // 确保你的模板文件名是 'settings_display.html' 并且在 'public/extensions/third-party/day2/' 目录下
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            // 尝试找到更可靠的注入目标
            const targetContainer = $('#extensions_settings') || $('#extension_settings') || $('body'); // 备用方案
            if (targetContainer.length) {
                targetContainer.append(settingsHtml);
                console.log(`[${extensionName}] Main: Settings UI injected.`);
                // 绑定刷新按钮事件
                $('#day1-refresh-button').on('click', updateStatsTable);
                // 初始加载一次数据
                setTimeout(updateStatsTable, 500); // 延迟加载，确保 UI 完全渲染
            } else {
                console.warn(`[${extensionName}] Main: Could not find suitable container (#extensions_settings) for settings UI.`);
            }
        } catch (error) {
            console.error(`[${extensionName}] Main: Error loading or injecting settings HTML: ${error}`);
        }

        // 初始化 Web Worker
        try {
            // 确保 worker.js 文件在 'public/extensions/third-party/day2/worker.js'
            const workerPath = `${extensionFolderPath}/worker.js`; // 使用变量构建路径
            day1Worker = new Worker(workerPath);
            day1Worker.onmessage = (event) => { /* console.log(`[${extensionName}] Main: Received message from worker:`, event.data); */ }; // 可以根据需要取消注释
            day1Worker.onerror = (error) => {
                console.error(`[${extensionName}] Main: Worker error reported:`, error.message, error);
                // 用户提示
                // toastr.error("后台统计进程出错，请检查控制台。", `${extensionName} 插件错误`);
            };
            console.log(`[${extensionName}] Main: Web Worker initialized successfully from path: ${workerPath}`);
        } catch (error) {
            console.error(`[${extensionName}] Main: Failed to initialize Web Worker from path "${extensionFolderPath}/worker.js":`, error);
            // 更明确的错误提示
            alert(`${extensionName} 插件未能成功加载后台处理程序，统计功能将不可用。请检查浏览器控制台错误信息，特别是关于 Worker 路径和 MIME 类型的问题。`);
            day1Worker = null; // 标记 worker 不可用
        }

        // --- 注册核心事件监听器 ---

        // 监听用户发送消息
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);

        // 监听聊天切换
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

        // **新增：监听准备好发送给 API 的数据 (GENERATE_AFTER_DATA)**
        // 这个事件在 API 请求发送前触发，用于预计算 Token
        eventSource.on(event_types.GENERATE_AFTER_DATA, async (generateData) => {
            // console.log(`[${extensionName}] GENERATE_AFTER_DATA triggered.`);
            const context = getContext();
            // 优先使用 generateData 中的 api 类型信息，如果不可靠再用全局的 mainApi
            const currentApi = generateData.type || context.mainApi || mainApi;
            let promptTokens = 0;

            // 忽略 dryRun 或没有当前实体的情况
            if (generateData.dryRun || !currentEntityId) {
                // console.log(`[${extensionName}] GENERATE_AFTER_DATA: Skipping (dryRun: ${generateData.dryRun}, currentEntityId: ${currentEntityId})`);
                return;
            }

            try {
                // 根据 API 类型选择不同的处理方式
                if (currentApi === 'openai' || generateData.is_openai) { // 检查 API 类型
                    const messages = generateData.prompt; // OpenAI 使用消息数组
                    if (Array.isArray(messages)) {
                        const tokenPromises = messages.map(message =>
                            // 确保内容存在，并使用 tokenizers.js 的函数
                            getTokenCountAsync(message.content || '', 0)
                        );
                        const tokensPerMessage = await Promise.all(tokenPromises);
                        promptTokens = tokensPerMessage.reduce((sum, count) => sum + count, 0);
                        // console.log(`[${extensionName}] GENERATE_AFTER_DATA (OpenAI): Calculated ${promptTokens} tokens from message array.`);
                    } else {
                        console.warn(`[${extensionName}] OpenAI generateData.prompt 格式非预期数组:`, messages);
                        promptTokens = 0; // 无法计算则为0
                    }
                } else {
                    const promptString = generateData.prompt; // 其他 API 使用字符串
                    if (typeof promptString === 'string') {
                        // power_user.token_padding 在新版可能不存在或位置改变，这里用 0 作为安全默认值
                        const padding = typeof power_user === 'object' ? (power_user.token_padding || 0) : 0;
                        promptTokens = await getTokenCountAsync(promptString, padding); // 使用 tokenizers.js 的函数
                        // console.log(`[${extensionName}] GENERATE_AFTER_DATA (${currentApi}): Calculated ${promptTokens} tokens from string (padding: ${padding}).`);
                    } else {
                         console.warn(`[${extensionName}] ${currentApi} generateData.prompt 格式非预期字符串:`, promptString);
                         promptTokens = 0; // 无法计算则为0
                    }
                }

                // 存储计算结果，并设置标志位
                lastCalculatedPromptTokens = promptTokens;
                lastUsedApi = currentApi; // 记录 API 类型
                pendingTokenConsumptionLog = true; // 表示我们计算了 Token，等待确认消耗
                // console.log(`[${extensionName}] Stored pre-calculated Prompt Tokens: ${promptTokens} for entity ${currentEntityId}. Setting pending flag to true.`);

            } catch (error) {
                console.error(`[${extensionName}] 在 GENERATE_AFTER_DATA 中计算 Token 时出错:`, error);
                pendingTokenConsumptionLog = false; // 出错时重置
                lastCalculatedPromptTokens = 0;
                lastUsedApi = '';
                // console.log(`[${extensionName}] Error in GENERATE_AFTER_DATA, resetting pending flag.`);
            }
        });

        // **新增：合并的 MESSAGE_RECEIVED 监听器**
        // 这个事件在收到 AI 回复后触发，用于确认 Prompt Token 消耗 和 记录 AI 回复消息
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
            // console.log(`[${extensionName}] MESSAGE_RECEIVED triggered (ID: ${messageId}, Type: ${type}). Pending flag: ${pendingTokenConsumptionLog}`);
            const context = getContext();

            // 1. 处理 AI 回复消息的 Token 统计 (来自原 onMessageReceived 的逻辑)
            if (context && context.chat && context.chat[messageId]) {
                 const message = context.chat[messageId];
                 // 确保是 AI 回复 (非用户、非系统)
                 if (message && !message.is_user && !message.is_system) {
                     // console.log(`[${extensionName}] MESSAGE_RECEIVED: Processing AI message ${messageId}`);
                     handleMessage(message, false); // isUser = false
                 }
            }

            // 2. 处理 Prompt Token 消耗确认
            if (pendingTokenConsumptionLog) {
                // console.log(`[${extensionName}] MESSAGE_RECEIVED: Confirming prompt token consumption.`);
                // 确保当前实体 ID 仍然有效
                if (!currentEntityId) {
                     console.warn(`[${extensionName}] MESSAGE_RECEIVED: Pending consumption log is true, but currentEntityId is null. Cannot record prompt tokens.`);
                     // 重置状态避免后续错误记录
                     pendingTokenConsumptionLog = false;
                     lastCalculatedPromptTokens = 0;
                     lastUsedApi = '';
                     return;
                }

                // 构造 payload 并发送给 Worker
                const payload = {
                    entityId: currentEntityId,
                    entityName: currentEntityName, // 发送当前名称
                    timestamp: Date.now(), // 使用当前时间戳记录确认消耗的时间点
                    promptTokenCount: lastCalculatedPromptTokens,
                };
                // console.log(`[${extensionName}] MESSAGE_RECEIVED: Sending 'recordPromptTokens' to worker:`, payload);
                sendMessageToWorker('recordPromptTokens', payload);

                // 重置标志位和存储的值，完成一次消耗记录
                pendingTokenConsumptionLog = false;
                lastCalculatedPromptTokens = 0;
                lastUsedApi = '';
                 // console.log(`[${extensionName}] MESSAGE_RECEIVED: Reset pending flag and token values.`);
            } else {
                // console.log(`[${extensionName}] MESSAGE_RECEIVED: No pending prompt token consumption to log.`);
            }
        });

        // **新增：监听生成停止 (GENERATION_STOPPED)**
        // 用于处理生成被中断或失败的情况，取消待记录的 Prompt Token
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            // console.log(`[${extensionName}] GENERATION_STOPPED triggered. Pending flag: ${pendingTokenConsumptionLog}`);
            if (pendingTokenConsumptionLog) {
                console.log(`[${extensionName}] GENERATION_STOPPED: Cancelling pending prompt token consumption log for entity ${currentEntityId}.`);
                // 重置状态，因为这次预计算的 Token 没有真正被消耗
                pendingTokenConsumptionLog = false;
                lastCalculatedPromptTokens = 0;
                lastUsedApi = '';
            }
        });

        // **移除：** 不再需要监听 GENERATE_AFTER_COMBINE_PROMPTS
        // eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, handlePromptBuilt);

        // 初始化时获取一次当前聊天上下文
        onChatChanged(getContext()?.chatId);

        console.log(`[${extensionName}] Main: Extension initialization complete. Event listeners registered.`);
    });

})();

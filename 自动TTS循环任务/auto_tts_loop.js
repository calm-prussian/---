<<taskjs>>
(async () => {
    // ========== 防重复初始化 ==========
    const isFirstRun = !window.__autoTTSInitialized;
    if (isFirstRun) {
        window.__autoTTSInitialized = true;
        console.log('[AutoTTS] 初始化开始');
    } else {
        console.log('[AutoTTS] 已初始化，打开面板');
    }

    // ========== 动态导入模块 ==========
    let chat, Generate;
    try {
        const scriptModule = await import('/script.js');
        chat = scriptModule.chat;
        Generate = scriptModule.Generate;
        console.log('[AutoTTS] 模块导入成功');
    } catch (e) {
        console.error('[AutoTTS] 模块导入失败:', e);
        return;
    }

    // ========== 常量 ==========
    const STORAGE_KEY = 'xiaobaix_auto_tts_config';
    const STATE_KEY = '__autoTTSState';
    const PANEL_ID = 'xiaobaix-auto-tts-panel';
    const STYLE_ID = 'xiaobaix-auto-tts-style';
    const LOG_PREFIX = '[AutoTTS]';

    const DEFAULT_CONFIG = {
        sendText: '',
        loopCount: 0,
        keyword: '',
        retryLimit: 3,
        ttsBtnRetry: 10,
        ttsBtnTimeout: 500,
        skipIfNoBtn: true
    };

    function log(msg, ...args) { console.log(LOG_PREFIX, msg, ...args); }
    function logWarn(msg, ...args) { console.warn(LOG_PREFIX, msg, ...args); }
    function logErr(msg, ...args) { console.error(LOG_PREFIX, msg, ...args); }

    // ========== 配置管理 ==========
    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const cfg = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
            log('配置加载:', cfg);
            return cfg;
        } catch (e) {
            logErr('配置加载失败:', e);
            return { ...DEFAULT_CONFIG };
        }
    }

    function saveConfig(cfg) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
            log('配置已保存');
        } catch (e) {
            logErr('配置保存失败:', e);
        }
    }

    let config = loadConfig();

    // ========== 运行时状态 ==========
    function loadState() {
        try {
            const s = window[STATE_KEY];
            return s || { currentLoop: 0, retryCount: 0, stopped: true, lastTriggered: null };
        } catch {
            return { currentLoop: 0, retryCount: 0, stopped: true, lastTriggered: null };
        }
    }

    function saveState(s) {
        try { window[STATE_KEY] = s; } catch (e) { logErr('状态保存失败:', e); }
    }

    let state = loadState();
    let floorListenerCleanup = null;
    let keepAliveId = null;
    let ttsBtnPollTimer = null;

    // ========== Cleanup ==========
    function cleanup() {
        log('执行 cleanup');

        if (floorListenerCleanup) {
            try { floorListenerCleanup(); } catch {}
            floorListenerCleanup = null;
        }

        if (keepAliveId) {
            clearInterval(keepAliveId);
            keepAliveId = null;
        }

        if (ttsBtnPollTimer) {
            clearTimeout(ttsBtnPollTimer);
            ttsBtnPollTimer = null;
        }

        if (window.xiaobaixTts?.player?.onStateChange === onTtsStateChange) {
            window.xiaobaixTts.player.onStateChange = null;
        }

        [PANEL_ID, STYLE_ID].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        delete window.__autoTTSInitialized;
        delete window[STATE_KEY];

        log('cleanup 完成');
    }

    // ========== TTS 辅助 ==========
    function getPlayer() {
        return window.xiaobaixTts?.player || null;
    }

    function findTtsBtnEl(messageId) {
        return document.querySelector(`.mes[mesid="${messageId}"] .xb-tts-btn.play-btn`);
    }

    async function findAndClickTtsBtn(messageId) {
        log('开始查找 TTS 按钮, messageId:', messageId, '重试上限:', config.ttsBtnRetry);

        for (let i = 0; i < config.ttsBtnRetry; i++) {
            const btn = findTtsBtnEl(messageId);
            if (btn) {
                log('TTS 按钮找到，第', i + 1, '次尝试，点击');
                btn.click();
                return true;
            }
            log('TTS 按钮未找到，第', i + 1, '次等待', config.ttsBtnTimeout, 'ms');
            await new Promise(r => { ttsBtnPollTimer = setTimeout(r, config.ttsBtnTimeout); });
        }

        logWarn('TTS 按钮查找超时, messageId:', messageId);
        return false;
    }

    // ========== 停止循环 ==========
    function stopLoop() {
        if (state.stopped) {
            log('已经处于停止状态，跳过');
            return;
        }

        log('停止循环');
        state.stopped = true;
        saveState(state);

        if (floorListenerCleanup) {
            try { floorListenerCleanup(); } catch {}
            floorListenerCleanup = null;
            log('floorListener 已移除');
        }

        if (ttsBtnPollTimer) {
            clearTimeout(ttsBtnPollTimer);
            ttsBtnPollTimer = null;
        }

        const player = getPlayer();
        if (player?.onStateChange === onTtsStateChange) {
            player.onStateChange = null;
            log('TTS onStateChange 已取消订阅');
        }
    }

    // ========== 发送 ==========
    async function send() {
        const ta = document.querySelector('#send_textarea');
        const sb = document.querySelector('#send_but');

        if (!ta || !sb) {
            logErr('找不到发送控件: #send_textarea 或 #send_but');
            stopLoop();
            return;
        }

        log('发送文本:', config.sendText);
        ta.value = config.sendText;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        sb.click();
    }

    // ========== AI 回复回调 ==========
    async function onAiReply(data) {
        if (state.stopped) {
            log('已停止，忽略 AI 回复');
            return;
        }

        const ctx = window.SillyTavern?.getContext?.();
        const currentChat = chat && chat.length ? chat : (ctx?.chat || []);
        const messageId = data?.messageId ?? (currentChat.length > 0 ? currentChat.length - 1 : null);

        if (!Number.isFinite(messageId)) {
            logWarn('无法获取 messageId');
            return;
        }

        log('AI 回复到达, messageId:', messageId, 'currentLoop:', state.currentLoop);

        state.currentLoop++;
        log('当前轮次:', state.currentLoop, '/', config.loopCount || '无限');
        saveState(state);

        if (config.loopCount > 0 && state.currentLoop > config.loopCount) {
            log('达到循环上限', config.loopCount, '停止');
            stopLoop();
            return;
        }

        const mesText = currentChat[messageId]?.mes || '';
        const keyword = config.keyword.trim();

        if (keyword && !mesText.includes(keyword)) {
            log('关键字不匹配: 期望"', keyword, '", 回复中未找到');
            if (state.retryCount < config.retryLimit) {
                state.retryCount++;
                log('重试 regenerage, 次数:', state.retryCount, '/', config.retryLimit);
                saveState(state);
                try {
                    await Generate('regenerate');
                } catch (e) {
                    logErr('regenerate 失败:', e);
                }
                return;
            }
            logWarn('关键字重试已达上限, 停止');
            stopLoop();
            return;
        }

        if (keyword) {
            log('关键字匹配成功');
        } else {
            log('无关键字检查要求');
        }

        state.retryCount = 0;
        saveState(state);

        const found = await findAndClickTtsBtn(messageId);
        if (!found) {
            logWarn('TTS 按钮未找到, skipIfNoBtn:', config.skipIfNoBtn);
            if (config.skipIfNoBtn) {
                log('跳过本轮, 继续下一轮');
                await send();
            } else {
                log('停止');
                stopLoop();
            }
        }
    }

    function onTtsStateChange(playerState, item) {
        if (playerState !== 'playing') {
            log('TTS 状态变化:', playerState, '(忽略)');
            return;
        }

        const msgId = item?.messageId;
        if (msgId == null && msgId !== 0) {
            logWarn('TTS playing 但无 messageId');
            return;
        }

        if (msgId === state.lastTriggered) {
            log('同条消息重复 playing, 忽略, messageId:', msgId);
            return;
        }

        log('TTS 开始播放, messageId:', msgId, 'lastTriggered 由', state.lastTriggered, '更新为', msgId);
        state.lastTriggered = msgId;
        saveState(state);

        if (state.stopped) {
            log('已停止，不发送下一轮');
            return;
        }

        if (config.loopCount > 0 && state.currentLoop >= config.loopCount) {
            log('已达到循环上限, 停止');
            stopLoop();
            return;
        }

        log('触发下一轮发送');
        send().catch(e => logErr('send 异常:', e));
    }

    // ========== 启动循环 ==========
    async function startLoop() {
        if (!config.sendText.trim()) {
            alert('[AutoTTS] 请先设置发送文本');
            logWarn('启动失败: 发送文本为空');
            return;
        }

        const player = getPlayer();
        if (!player) {
            alert('[AutoTTS] 未检测到 TTS 播放器 (window.xiaobaixTts.player)，请确保小白X扩展已加载');
            logWarn('启动失败: TTS 播放器未找到');
            return;
        }

        if (!state.stopped) {
            log('先停止当前循环');
            stopLoop();
        }

        log('========== 开始循环 ==========');
        log('配置:', config);

        state.stopped = false;
        state.currentLoop = 0;
        state.retryCount = 0;
        state.lastTriggered = null;
        saveState(state);

        floorListenerCleanup = addFloorListener(onAiReply, {
            interval: 1,
            timing: 'after_ai',
            floorType: 'llm'
        });
        log('floorListener 已注册 (after_ai, llm)');

        player.onStateChange = onTtsStateChange;
        log('TTS onStateChange 已订阅');

        await send();
    }

    // ========== UI ==========
    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
#${PANEL_ID} {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    z-index: 99999;
    background: #2d2d3f; border: 1px solid #6c5ce7; border-radius: 12px;
    padding: 20px; width: 360px; max-height: 85vh; overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    color: #e0e0e0; font-size: 13px; font-family: system-ui, sans-serif;
}
#${PANEL_ID}.hidden { display: none; }
#${PANEL_ID} h3 {
    margin: 0 0 16px 0; font-size: 16px; color: #a29bfe;
}
#${PANEL_ID} label {
    display: block; margin-bottom: 4px; color: #b0b0c0; font-size: 12px;
}
#${PANEL_ID} textarea,
#${PANEL_ID} input[type="text"],
#${PANEL_ID} input[type="number"] {
    width: 100%; padding: 8px; margin-bottom: 12px;
    border: 1px solid #444; border-radius: 6px;
    background: #1a1a2e; color: #e0e0e0; font-size: 13px; box-sizing: border-box;
}
#${PANEL_ID} textarea { resize: vertical; min-height: 60px; }
#${PANEL_ID} .checkbox-row {
    display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
}
#${PANEL_ID} .checkbox-row input[type="checkbox"] { margin: 0; }
#${PANEL_ID} .btn-row {
    display: flex; gap: 8px; flex-wrap: wrap;
}
#${PANEL_ID} .btn-row button {
    padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 600; color: #fff;
}
#${PANEL_ID} .btn-start { background: #00b894; flex: 1; }
#${PANEL_ID} .btn-stop { background: #e17055; flex: 1; }
#${PANEL_ID} .btn-save { background: #6c5ce7; }
#${PANEL_ID} .btn-close-panel { background: #444; color: #ccc !important; }
`;
        document.head.appendChild(style);
        log('样式已注入');
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function createPanel() {
        if (document.getElementById(PANEL_ID)) {
            log('面板已存在，跳过创建');
            return;
        }

        log('创建设置面板');
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'hidden';
        panel.innerHTML = `
<h3>Auto TTS 循环设置</h3>

<label>发送文本</label>
<textarea id="atts-send-text" placeholder="输入要发送的文本...">${escapeHtml(config.sendText)}</textarea>

<label>循环次数 (0 = 无限)</label>
<input type="number" id="atts-loop-count" value="${config.loopCount}" min="0">

<label>必含关键字 (留空 = 不检查)</label>
<input type="text" id="atts-keyword" value="${escapeHtml(config.keyword)}" placeholder="留空则不检查关键字">

<label>关键字不匹配时最大重试次数</label>
<input type="number" id="atts-retry-limit" value="${config.retryLimit}" min="0">

<label>查找TTS按钮重试次数</label>
<input type="number" id="atts-btn-retry" value="${config.ttsBtnRetry}" min="1">

<label>查找TTS按钮轮询间隔 (ms)</label>
<input type="number" id="atts-btn-timeout" value="${config.ttsBtnTimeout}" min="100">

<div class="checkbox-row">
    <input type="checkbox" id="atts-skip-no-btn" ${config.skipIfNoBtn ? 'checked' : ''}>
    <label for="atts-skip-no-btn" style="margin:0">找不到TTS按钮时跳过继续下一轮</label>
</div>

<div class="btn-row">
    <button id="atts-btn-save" class="btn-save">保存设置</button>
    <button id="atts-btn-close-panel" class="btn-close-panel">关闭</button>
</div>

<div class="btn-row" style="margin-top:8px">
    <button id="atts-btn-start" class="btn-start">▶ 开始循环</button>
    <button id="atts-btn-stop" class="btn-stop">⏹ 结束循环</button>
</div>
`;
        document.body.appendChild(panel);

        // 事件绑定
        panel.querySelector('#atts-btn-save').addEventListener('click', () => {
            log('点击: 保存设置');
            flushPanelToConfig();
        });
        panel.querySelector('#atts-btn-close-panel').addEventListener('click', () => {
            log('点击: 关闭面板');
            hidePanel();
        });
        panel.querySelector('#atts-btn-start').addEventListener('click', () => {
            log('点击: 开始循环');
            flushPanelToConfig();
            startLoop();
        });
        panel.querySelector('#atts-btn-stop').addEventListener('click', () => {
            log('点击: 结束循环');
            stopLoop();
        });

        log('面板创建完成');
    }

    function showPanel() {
        createPanel();
        syncConfigToPanel();
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
            panel.classList.remove('hidden');
            log('面板打开');
        }
    }

    function hidePanel() {
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
            panel.classList.add('hidden');
            log('面板关闭');
        }
    }

    function syncConfigToPanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelector('#atts-send-text').value = config.sendText || '';
        panel.querySelector('#atts-loop-count').value = config.loopCount;
        panel.querySelector('#atts-keyword').value = config.keyword || '';
        panel.querySelector('#atts-retry-limit').value = config.retryLimit;
        panel.querySelector('#atts-btn-retry').value = config.ttsBtnRetry;
        panel.querySelector('#atts-btn-timeout').value = config.ttsBtnTimeout;
        panel.querySelector('#atts-skip-no-btn').checked = config.skipIfNoBtn;
    }

    function flushPanelToConfig() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        config.sendText = panel.querySelector('#atts-send-text')?.value || '';
        config.loopCount = parseInt(panel.querySelector('#atts-loop-count')?.value) || 0;
        config.keyword = panel.querySelector('#atts-keyword')?.value || '';
        config.retryLimit = parseInt(panel.querySelector('#atts-retry-limit')?.value) || 0;
        config.ttsBtnRetry = parseInt(panel.querySelector('#atts-btn-retry')?.value) || 1;
        config.ttsBtnTimeout = parseInt(panel.querySelector('#atts-btn-timeout')?.value) || 100;
        config.skipIfNoBtn = panel.querySelector('#atts-skip-no-btn')?.checked ?? true;
        saveConfig(config);
        log('面板数据已同步到配置:', config);
    }

    // ========== 状态恢复 ==========
    async function restoreState() {
        if (state.stopped) {
            log('上次状态为已停止，不恢复');
            return;
        }

        log('检测到上次运行中状态，尝试恢复...');
        const player = getPlayer();
        if (!player) {
            logWarn('恢复失败: TTS 播放器不存在');
            state.stopped = true;
            saveState(state);
            return;
        }

        floorListenerCleanup = addFloorListener(onAiReply, {
            interval: 1,
            timing: 'after_ai',
            floorType: 'llm'
        });
        log('floorListener 已恢复');

        player.onStateChange = onTtsStateChange;
        log('TTS onStateChange 已恢复');
    }

    // ========== 初始化 ==========
    if (!isFirstRun) {
        showPanel();
        return;
    }

    injectStyles();

    keepAliveId = setInterval(() => {}, 60000);
    log('keepAlive 已启动');

    await restoreState();

    showPanel();
    log('========== 初始化完成 ==========');

    return { cleanup, start: startLoop, stop: stopLoop };
})();
<</taskjs>>

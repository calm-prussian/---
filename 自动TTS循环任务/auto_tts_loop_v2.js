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
    let chat, Generate, eventSource, event_types;
    try {
        const scriptModule = await import('/script.js');
        chat = scriptModule.chat;
        Generate = scriptModule.Generate;
        eventSource = scriptModule.eventSource;
        event_types = scriptModule.event_types;
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
    const TTS_FALLBACK_MS = 30000;

    const DEFAULT_CONFIG = {
        sendText: '',
        loopCount: 0,
        keyword: '',
        retryLimit: 3
    };

    // ========== 日志系统 (去重折叠 + 面板实时显示) ==========
    const LOG_BUF_KEY = '__autoTTSLogBuffer';
    const LOG_MAX = 300;
    window[LOG_BUF_KEY] = window[LOG_BUF_KEY] || [];

    function pushLog(level, msg, ...args) {
        const raw = [msg, ...args].map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        const buf = window[LOG_BUF_KEY];
        const prev = buf[buf.length - 1];
        const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });

        if (prev && prev.level === level && prev.msg === raw) {
            prev.repeat++;
            prev.time = now;
        } else {
            buf.push({ time: now, level, msg: raw, repeat: 1 });
            if (buf.length > LOG_MAX) buf.shift();
        }

        const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        consoleFn(LOG_PREFIX, msg, ...args);

        const logList = document.getElementById('atts-log-list');
        if (logList && logList.offsetParent !== null) {
            renderLogList();
        }
    }

    function log(msg, ...args) { pushLog('info', msg, ...args); }
    function logWarn(msg, ...args) { pushLog('warn', msg, ...args); }
    function logErr(msg, ...args) { pushLog('error', msg, ...args); }

    function formatConfig(cfg) {
        const parts = [];
        parts.push('loop=' + (cfg.loopCount || '∞'));
        if (cfg.keyword) parts.push('keyword=' + cfg.keyword);
        parts.push('retry=' + cfg.retryLimit);
        return parts.join(', ');
    }

    // ========== 配置管理 ==========
    function loadConfig() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const cfg = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
            log('配置: ' + formatConfig(cfg));
            return cfg;
        } catch (e) {
            logErr('配置加载失败:', e);
            return { ...DEFAULT_CONFIG };
        }
    }

    function saveConfig(cfg) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); log('配置已保存'); } catch (e) { logErr('配置保存失败:', e); }
    }

    let config = loadConfig();

    // ========== 运行时状态 ==========
    function loadState() {
        try { const s = window[STATE_KEY]; return s || { currentLoop: 0, retryCount: 0, stopped: true, lastTriggered: null }; }
        catch { return { currentLoop: 0, retryCount: 0, stopped: true, lastTriggered: null }; }
    }
    function saveState(s) { try { window[STATE_KEY] = s; } catch (e) { logErr('状态保存失败:', e); } }

    let state = loadState();
    let floorListenerCleanup = null;
    let eventSourceSubscribed = false;
    let keepAliveId = null;
    let ttsFallbackTimer = null;
    let lastProcessedMsgId = null;
    let ttsActiveMsgId = null;

    // ========== Cleanup ==========
    function cleanup() {
        log('执行 cleanup');
        if (floorListenerCleanup) { try { floorListenerCleanup(); } catch {} floorListenerCleanup = null; }
        if (eventSourceSubscribed && eventSource && event_types) {
            try { eventSource.off(event_types.CHARACTER_MESSAGE_RENDERED, onAiReply); } catch {} eventSourceSubscribed = false;
        }
        if (keepAliveId) { clearInterval(keepAliveId); keepAliveId = null; }
        if (ttsFallbackTimer) { clearTimeout(ttsFallbackTimer); ttsFallbackTimer = null; }
        if (window.xiaobaixTts?.player?.onStateChange === onTtsStateChange) { window.xiaobaixTts.player.onStateChange = null; }
        [PANEL_ID, STYLE_ID].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });
        delete window.__autoTTSInitialized;
        delete window[STATE_KEY];
        delete window[LOG_BUF_KEY];
        log('cleanup 完成');
    }

    // ========== TTS 触发 ==========
    function getPlayer() {
        return window.xiaobaixTts?.player || null;
    }

    function setupFallback(messageId) {
        if (ttsFallbackTimer) clearTimeout(ttsFallbackTimer);
        ttsFallbackTimer = setTimeout(() => {
            if (ttsActiveMsgId === messageId) return;
            if (state.stopped) return;
            logWarn('TTS', TTS_FALLBACK_MS / 1000, 's 未播放, 跳过本轮, messageId:', messageId);
            send().catch(e => logErr('send 异常:', e));
        }, TTS_FALLBACK_MS);
    }

    // ========== 停止循环 ==========
    function stopLoop() {
        if (state.stopped) { log('已经处于停止状态，跳过'); return; }
        log('停止循环');
        state.stopped = true; saveState(state);
        if (floorListenerCleanup) { try { floorListenerCleanup(); } catch {} floorListenerCleanup = null; log('floorListener 已移除'); }
        if (eventSourceSubscribed && eventSource && event_types) {
            try { eventSource.off(event_types.CHARACTER_MESSAGE_RENDERED, onAiReply); } catch {} eventSourceSubscribed = false; log('eventSource 已取消订阅');
        }
        if (ttsFallbackTimer) { clearTimeout(ttsFallbackTimer); ttsFallbackTimer = null; }
        const player = getPlayer();
        if (player?.onStateChange === onTtsStateChange) { player.onStateChange = null; log('TTS onStateChange 已取消订阅'); }
        ttsActiveMsgId = null;
        updateStatusBar();
    }

    // ========== 发送 ==========
    async function send() {
        const SEND_WAIT_MAX = 150;
        for (let i = 0; i < SEND_WAIT_MAX; i++) {
            if (state.stopped) return;
            const sb = document.querySelector('#send_but');
            if (sb && !sb.disabled) break;
            if (i === 0) log('等待 AI 生成完成...');
            await new Promise(r => setTimeout(r, 200));
        }
        const ta = document.querySelector('#send_textarea');
        const sb = document.querySelector('#send_but');
        if (!ta || !sb) { logErr('找不到发送控件'); stopLoop(); return; }
        if (sb.disabled) { logErr('发送按钮仍不可用，跳过本轮'); stopLoop(); return; }
        log('发送文本:', config.sendText);
        ta.value = config.sendText;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof $ !== 'undefined') $(ta).trigger('input').trigger('change');
        setTimeout(() => sb.click(), 50);
    }

    // ========== AI 回复回调 ==========
    async function onAiReply(data) {
        if (state.stopped) return;
        const ctx = window.SillyTavern?.getContext?.();
        const currentChat = chat && chat.length ? chat : (ctx?.chat || []);
        const messageId = data?.messageId ?? (currentChat.length > 0 ? currentChat.length - 1 : null);
        if (!Number.isFinite(messageId)) return;
        if (messageId === lastProcessedMsgId) { log('跳过重复触发 (messageId:', messageId, ')'); return; }
        lastProcessedMsgId = messageId;

        log('AI 回复到达, messageId:', messageId, 'currentLoop:', state.currentLoop);
        state.currentLoop++;
        log('当前轮次:', state.currentLoop, '/', config.loopCount || '无限');
        saveState(state);
        updateStatusBar();

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
                state.retryCount++; log('重试 regenerage, 次数:', state.retryCount, '/', config.retryLimit); saveState(state);
                try { await Generate('regenerate'); } catch (e) { logErr('regenerate 失败:', e); }
                return;
            }
            logWarn('关键字重试已达上限, 停止'); stopLoop(); return;
        }
        if (keyword) { log('关键字匹配成功'); } else { log('无关键字检查要求'); }
        state.retryCount = 0; saveState(state);

        setupFallback(messageId);
    }

    // ========== TTS 播放回调 ==========
    function onTtsStateChange(playerState, item) {
        const msgId = item?.messageId;

        if (playerState === 'playing') {
            if (ttsFallbackTimer) { clearTimeout(ttsFallbackTimer); ttsFallbackTimer = null; }
            ttsActiveMsgId = msgId;
        } else if (playerState === 'idle') {
            ttsActiveMsgId = null;
            if (state.stopped) { updateStatusBar(); return; }
            if (config.loopCount > 0 && state.currentLoop >= config.loopCount) { log('已达到循环上限, 停止'); stopLoop(); return; }
            log('TTS 播放完毕, 触发下一轮发送');
            setTimeout(() => send().catch(e => logErr('send 异常:', e)), 100);
        } else if (playerState === 'stopped' || playerState === 'cleared') {
            ttsActiveMsgId = null;
        }

        updateStatusBar();

        if (playerState !== 'playing') return;

        if (msgId == null && msgId !== 0) { logWarn('TTS playing 但无 messageId'); return; }
        if (msgId === state.lastTriggered) { log('同条消息重复 playing, 忽略, messageId:', msgId); return; }

        log('TTS 开始播放, messageId:', msgId, 'lastTriggered 由', state.lastTriggered, '更新为', msgId);
        state.lastTriggered = msgId; saveState(state);
    }

    // ========== 启动循环 ==========
    async function startLoop() {
        if (!config.sendText.trim()) { alert('[AutoTTS] 请先设置发送文本'); logWarn('启动失败: 发送文本为空'); return; }
        const player = getPlayer();
        if (!player) { alert('[AutoTTS] 未检测到 TTS 播放器，请确保小白X扩展已加载'); logWarn('启动失败: TTS 播放器未找到'); return; }
        if (!state.stopped) { log('先停止当前循环'); stopLoop(); }

        log('========== 开始循环 ==========');
        log('[配置]', formatConfig(config));

        state.stopped = false; state.currentLoop = 0; state.retryCount = 0; state.lastTriggered = null;
        lastProcessedMsgId = null; ttsActiveMsgId = null;
        if (ttsFallbackTimer) { clearTimeout(ttsFallbackTimer); ttsFallbackTimer = null; }
        saveState(state);

        floorListenerCleanup = addFloorListener(onAiReply, { interval: 1, timing: 'after_ai', floorType: 'llm' });
        log('floorListener 已注册 (after_ai, llm)');
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onAiReply);
        eventSourceSubscribed = true;
        log('eventSource 已订阅 CHARACTER_MESSAGE_RENDERED');
        player.onStateChange = onTtsStateChange;
        log('TTS onStateChange 已订阅');
        log('提示: 请确保小白X TTS 的「自动播放」已开启');
        updateStatusBar();
        await send();
    }

    // ========== UI ==========
    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
#${PANEL_ID} {
    position: fixed; top: 80px; left: 100px; z-index: 99999;
    background: #2d2d3f; border: 1px solid #6c5ce7; border-radius: 12px;
    padding: 20px; width: min(440px, calc(100vw - 40px)); max-height: 85vh;
    overflow-y: auto; overflow-x: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    color: #e0e0e0; font-size: 13px; font-family: system-ui, sans-serif;
}
#${PANEL_ID}.hidden { display: none; }
#${PANEL_ID} .atts-tabs {
    display: flex; gap: 0; margin-bottom: 12px; border-bottom: 2px solid #444;
    cursor: move; user-select: none; padding-bottom: 2px;
}
#${PANEL_ID} .atts-tab {
    padding: 6px 16px; border: none; background: none; color: #888;
    cursor: pointer; font-size: 14px; font-weight: 600; border-bottom: 2px solid transparent;
    margin-bottom: -2px; transition: all 0.2s;
}
#${PANEL_ID} .atts-tab.active { color: #a29bfe; border-bottom-color: #6c5ce7; }
#${PANEL_ID} .atts-status-bar {
    padding: 10px 12px; margin-bottom: 10px;
    background: #1a1a2e; border: 1px solid #444; border-radius: 8px;
    font-size: 12px; color: #aaa; user-select: none;
}
#${PANEL_ID} .atts-status-bar.stopped { opacity: 0.5; }
#${PANEL_ID} .atts-status-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
#${PANEL_ID} .atts-status-dot { font-size: 10px; }
#${PANEL_ID} .atts-status-dot.running { color: #00b894; }
#${PANEL_ID} .atts-status-sep { color: #555; }
#${PANEL_ID} .atts-floor-link { color: #a29bfe; cursor: pointer; text-decoration: underline; }
#${PANEL_ID} .atts-floor-link:hover { color: #c4b9ff; }
#${PANEL_ID} .atts-progress-bar { height: 4px; background: #333; border-radius: 2px; overflow: hidden; }
#${PANEL_ID} .atts-progress-fill {
    height: 100%; background: linear-gradient(90deg, #6c5ce7, #00b894);
    border-radius: 2px; transition: width 0.3s;
}
#${PANEL_ID} .atts-progress-fill.infinite { width: 30% !important; animation: atts-pulse 1.5s ease-in-out infinite; }
@keyframes atts-pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
#${PANEL_ID} .atts-tab-content { display: none; }
#${PANEL_ID} .atts-tab-content.active { display: block; }
#${PANEL_ID} .atts-group {
    background: #1a1a2e; border: 1px solid #333; border-radius: 8px;
    padding: 0 12px 10px 12px; margin-bottom: 10px;
}
#${PANEL_ID} .atts-group[open] { border-color: #444; }
#${PANEL_ID} .atts-group-title {
    padding: 8px 0 6px 0; cursor: pointer; color: #b0b0c0;
    font-size: 12px; font-weight: 600; list-style: none; outline: none;
    display: flex; align-items: center; gap: 6px;
}
#${PANEL_ID} .atts-group-title::-webkit-details-marker { display: none; }
#${PANEL_ID} .atts-group-title::before { content: '▸'; font-size: 10px; transition: transform 0.2s; color: #666; }
#${PANEL_ID} .atts-group[open] > .atts-group-title::before { transform: rotate(90deg); color: #a29bfe; }
#${PANEL_ID} .atts-group-title:hover { color: #ccc; }
#${PANEL_ID} .atts-log-list {
    max-height: 350px; overflow-y: auto; background: #1a1a2e;
    border: 1px solid #444; border-radius: 6px; padding: 6px;
    font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
    font-size: 11px; line-height: 1.6; margin-bottom: 8px; word-break: break-all;
}
#${PANEL_ID} .atts-log-item { padding: 1px 0; border-bottom: 1px solid #2a2a3e; }
#${PANEL_ID} .atts-log-item.info { color: #bbb; }
#${PANEL_ID} .atts-log-item.warn { color: #f0c060; }
#${PANEL_ID} .atts-log-item.error { color: #e17055; }
#${PANEL_ID} .atts-log-time { color: #666; margin-right: 6px; }
#${PANEL_ID} .atts-log-repeat { color: #888; font-size: 10px; }
#${PANEL_ID} .atts-log-empty { color: #666; text-align: center; padding: 20px 0; }
#${PANEL_ID} label { display: block; margin-bottom: 4px; color: #b0b0c0; font-size: 12px; }
#${PANEL_ID} textarea, #${PANEL_ID} input[type="text"], #${PANEL_ID} input[type="number"] {
    width: 100%; padding: 8px; margin-bottom: 12px;
    border: 1px solid #444; border-radius: 6px;
    background: #1a1a2e; color: #e0e0e0; font-size: 13px; box-sizing: border-box;
}
#${PANEL_ID} textarea { resize: vertical; min-height: 60px; }
#${PANEL_ID} .checkbox-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
#${PANEL_ID} .checkbox-row input[type="checkbox"] { margin: 0; }
#${PANEL_ID} .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
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
        if (document.getElementById(PANEL_ID)) { log('面板已存在，跳过创建'); return; }
        log('创建设置面板');
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'hidden';
        panel.innerHTML = `
<div class="atts-tabs">
    <button id="atts-tab-settings" class="atts-tab active">设置</button>
    <button id="atts-tab-log" class="atts-tab">日志</button>
</div>

<div id="atts-status-bar">
    <div class="atts-status-row">
        <span id="atts-status-dot" class="atts-status-dot">○</span>
        <span id="atts-status-text">已停止</span>
        <span class="atts-status-sep">|</span>
        <span id="atts-status-loop">轮次 -/-</span>
        <span class="atts-status-sep">|</span>
        <span id="atts-status-floor">楼层 -</span>
    </div>
    <div id="atts-progress-bar" class="atts-progress-bar" style="display:none">
        <div id="atts-progress-fill" class="atts-progress-fill" style="width:0%"></div>
    </div>
</div>

<div id="atts-content-settings" class="atts-tab-content active">

<details class="atts-group" open>
    <summary class="atts-group-title">发送设置</summary>
    <textarea id="atts-send-text" placeholder="输入要发送的文本...">${escapeHtml(config.sendText)}</textarea>
</details>

<details class="atts-group" open>
    <summary class="atts-group-title">循环控制</summary>
    <label>循环次数 (0 = 无限)</label>
    <input type="number" id="atts-loop-count" value="${config.loopCount}" min="0">
    <label>必含关键字 (留空 = 不检查)</label>
    <input type="text" id="atts-keyword" value="${escapeHtml(config.keyword)}" placeholder="留空则不检查关键字">
    <label>关键字不匹配时最大重试次数</label>
    <input type="number" id="atts-retry-limit" value="${config.retryLimit}" min="0">
</details>

<div class="btn-row">
    <button id="atts-btn-save" class="btn-save">保存设置</button>
    <button id="atts-btn-close-panel" class="btn-close-panel">关闭</button>
</div>

<div class="btn-row" style="margin-top:8px">
    <button id="atts-btn-start" class="btn-start">▶ 开始循环</button>
    <button id="atts-btn-stop" class="btn-stop">⏹ 结束循环</button>
</div>

</div>

<div id="atts-content-log" class="atts-tab-content">
    <div id="atts-log-list" class="atts-log-list"></div>
    <div class="btn-row">
        <button id="atts-btn-clear-log" class="btn-save">清空日志</button>
        <button id="atts-btn-copy-log" class="btn-save">复制全部</button>
    </div>
</div>
`;
        document.body.appendChild(panel);

        panel.querySelector('#atts-btn-save').addEventListener('click', () => { log('点击: 保存设置'); flushPanelToConfig(); flashStatusSaved(); });
        panel.querySelector('#atts-btn-close-panel').addEventListener('click', () => { log('点击: 关闭面板'); hidePanel(); });
        panel.querySelector('#atts-btn-start').addEventListener('click', () => { log('点击: 开始循环'); flushPanelToConfig(); startLoop(); hidePanel(); });
        panel.querySelector('#atts-btn-stop').addEventListener('click', () => { log('点击: 结束循环'); stopLoop(); });
        panel.querySelector('#atts-tab-settings').addEventListener('click', () => switchTab('settings'));
        panel.querySelector('#atts-tab-log').addEventListener('click', () => switchTab('log'));
        panel.querySelector('#atts-btn-clear-log').addEventListener('click', clearLog);
        panel.querySelector('#atts-btn-copy-log').addEventListener('click', copyLog);

        panel.querySelector('#atts-status-bar').addEventListener('click', (e) => {
            const link = e.target.closest('.atts-floor-link');
            if (!link) return;
            const mesid = link.dataset.mesid;
            const msgEl = document.querySelector(`.mes[mesid="${mesid}"]`);
            if (!msgEl) return;
            msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            msgEl.style.outline = '3px solid #a29bfe';
            msgEl.style.outlineOffset = '2px';
            setTimeout(() => { msgEl.style.outline = ''; msgEl.style.outlineOffset = ''; }, 2000);
            log('跳转到楼层', mesid);
        });

        let drag = null;
        const tabs = panel.querySelector('.atts-tabs');
        tabs.addEventListener('mousedown', (e) => {
            if (e.target !== tabs && e.target.closest('.atts-tab')) return;
            drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!drag) return;
            panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - drag.x)) + 'px';
            panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.y)) + 'px';
        });
        document.addEventListener('mouseup', () => { drag = null; });

        log('面板创建完成');
    }

    function showPanel() {
        createPanel();
        syncConfigToPanel();
        const panel = document.getElementById(PANEL_ID);
        if (panel) { panel.classList.remove('hidden'); switchTab('settings'); updateStatusBar(); log('面板打开'); }
    }

    function hidePanel() {
        const panel = document.getElementById(PANEL_ID);
        if (panel) { panel.classList.add('hidden'); log('面板关闭'); }
    }

    function syncConfigToPanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelector('#atts-send-text').value = config.sendText || '';
        panel.querySelector('#atts-loop-count').value = config.loopCount;
        panel.querySelector('#atts-keyword').value = config.keyword || '';
        panel.querySelector('#atts-retry-limit').value = config.retryLimit;
    }

    function flushPanelToConfig() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        config.sendText = panel.querySelector('#atts-send-text')?.value || '';
        config.loopCount = parseInt(panel.querySelector('#atts-loop-count')?.value) || 0;
        config.keyword = panel.querySelector('#atts-keyword')?.value || '';
        config.retryLimit = parseInt(panel.querySelector('#atts-retry-limit')?.value) || 0;
        saveConfig(config);
        log('配置: ' + formatConfig(config));
    }

    function updateStatusBar() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        const bar = panel.querySelector('#atts-status-bar');
        const dot = panel.querySelector('#atts-status-dot');
        const text = panel.querySelector('#atts-status-text');
        const loop = panel.querySelector('#atts-status-loop');
        const floor = panel.querySelector('#atts-status-floor');
        const pbar = panel.querySelector('#atts-progress-bar');
        const pfill = panel.querySelector('#atts-progress-fill');
        if (!bar || !dot || !text || !loop || !floor) return;

        const running = !state.stopped;
        bar.classList.toggle('stopped', !running);
        dot.classList.toggle('running', running);
        dot.textContent = running ? '●' : '○';
        text.textContent = running ? '运行中' : '已停止';

        const max = config.loopCount === 0 ? '∞' : config.loopCount;
        loop.textContent = `轮次 ${state.currentLoop}/${max}`;

        if (ttsActiveMsgId != null) {
            floor.innerHTML = `楼层 <a class="atts-floor-link" data-mesid="${ttsActiveMsgId}">${ttsActiveMsgId}</a> 🔊`;
        } else if (running && state.lastTriggered != null) {
            floor.innerHTML = `楼层 <a class="atts-floor-link" data-mesid="${state.lastTriggered}">${state.lastTriggered}</a>`;
        } else {
            floor.innerHTML = '楼层 -';
        }

        if (running && config.loopCount > 0) {
            pbar.style.display = '';
            const pct = Math.min(100, Math.round(state.currentLoop / config.loopCount * 100));
            pfill.style.width = pct + '%'; pfill.classList.remove('infinite');
        } else if (running && config.loopCount === 0) {
            pbar.style.display = ''; pfill.classList.add('infinite');
        } else {
            pbar.style.display = 'none';
        }
    }

    function flashStatusSaved() {
        const text = document.querySelector('#atts-status-text');
        if (!text) return;
        text.textContent = '✓ 已保存'; text.style.color = '#00b894';
        setTimeout(() => { text.style.color = ''; updateStatusBar(); }, 1200);
    }

    function switchTab(name) {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        panel.querySelector('#atts-tab-settings').classList.toggle('active', name === 'settings');
        panel.querySelector('#atts-tab-log').classList.toggle('active', name === 'log');
        panel.querySelector('#atts-content-settings').classList.toggle('active', name === 'settings');
        panel.querySelector('#atts-content-log').classList.toggle('active', name === 'log');
        if (name === 'log') renderLogList();
    }

    function renderLogList() {
        const container = document.getElementById('atts-log-list');
        if (!container) return;
        const buf = window[LOG_BUF_KEY];
        if (!buf || !buf.length) { container.innerHTML = '<div class="atts-log-empty">暂无日志</div>'; return; }
        container.innerHTML = buf.map(e => {
            const repeat = e.repeat > 1 ? ` <span class="atts-log-repeat">×${e.repeat}</span>` : '';
            return `<div class="atts-log-item ${e.level}"><span class="atts-log-time">${e.time}</span>${escapeHtml(e.msg)}${repeat}</div>`;
        }).join('');
        container.scrollTop = container.scrollHeight;
    }

    function clearLog() { window[LOG_BUF_KEY] = []; log('日志已清空'); }

    async function copyLog() {
        const buf = window[LOG_BUF_KEY] || [];
        if (!buf.length) return;
        const text = buf.map(e => { const r = e.repeat > 1 ? ` ×${e.repeat}` : ''; return `[${e.time}] ${e.level.toUpperCase()} ${e.msg}${r}`; }).join('\n');
        try { await navigator.clipboard.writeText(text); log('日志已复制到剪贴板'); } catch {
            const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); log('日志已复制到剪贴板');
        }
    }

    // ========== 状态恢复 ==========
    async function restoreState() {
        if (state.stopped) { log('上次状态为已停止，不恢复'); return; }
        log('检测到上次运行中状态，尝试恢复...');
        const player = getPlayer();
        if (!player) { logWarn('恢复失败: TTS 播放器不存在'); state.stopped = true; saveState(state); return; }
        floorListenerCleanup = addFloorListener(onAiReply, { interval: 1, timing: 'after_ai', floorType: 'llm' });
        log('floorListener 已恢复');
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onAiReply);
        eventSourceSubscribed = true; log('eventSource 已恢复');
        player.onStateChange = onTtsStateChange; log('TTS onStateChange 已恢复');
    }

    // ========== 初始化 ==========
    if (!isFirstRun) { showPanel(); return; }

    injectStyles();
    keepAliveId = setInterval(() => {}, 60000);
    log('keepAlive 已启动');
    await restoreState();
    showPanel();
    log('========== 初始化完成 ==========');

    return { cleanup, start: startLoop, stop: stopLoop };
})();
<</taskjs>>

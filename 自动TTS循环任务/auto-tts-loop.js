<<taskjs>>
(async () => {
    if (window._cleanup) {
        window._cleanup();
        delete window._cleanup;
        delete window._running;
    }
    window._running = true;

    const { chat, Generate } = await import('/script.js');

    let s = false;
    let lastTriggered = null;
    let loopCount = 0;
    let retryCount = 0;
    let stopped = true;
    let retryTimer = null;
    const keepAlive = setInterval(() => {}, 60000);

    let cfg = { text: '你好，请介绍一下自己。', maxLoop: 0, mustContain: '', maxRetries: 3 };

    try {
        const saved = localStorage.getItem('auto_tts_cfg');
        if (saved) Object.assign(cfg, JSON.parse(saved));
        if (!cfg.mustContain) cfg.mustContain = '';
        if (!cfg.maxRetries) cfg.maxRetries = 3;
    } catch {}

    function saveCfg() {
        localStorage.setItem('auto_tts_cfg', JSON.stringify(cfg));
    }

    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    async function send() {
        if (s) return;
        if (cfg.maxLoop > 0 && loopCount >= cfg.maxLoop) {
            console.log(`[AutoTTS] 达到最大循环次数(${cfg.maxLoop})，停止发送`);
            stopped = true;
            showToast(`已达最大循环次数(${cfg.maxLoop})`);
            return;
        }
        s = true;
        loopCount++;
        console.log(`[AutoTTS] 第${loopCount}次发送: ${cfg.text.substring(0, 20)}`);
        const t = document.getElementById('send_textarea');
        const b = document.getElementById('send_but');
        if (!t || !b) {
            console.error('[AutoTTS] 找不到输入框或发送按钮');
            s = false;
            return;
        }
        t.value = cfg.text;
        t.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        b.click();
        setTimeout(() => { s = false; }, 2000);
    }

    function showToast(msg) {
        const existing = document.getElementById('atts_toast');
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.id = 'atts_toast';
        el.textContent = msg;
        el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:10px 20px;border-radius:8px;z-index:100000;font-size:14px;transition:opacity .5s';
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, 3000);
    }

    let originalOnStateChange = null;

    if (window.xiaobaixTts && window.xiaobaixTts.player) {
        const p = window.xiaobaixTts.player;
        originalOnStateChange = p.onStateChange;
        p.onStateChange = (state, item) => {
            try {
                console.log('[AutoTTS] TTS状态:', state, item?.messageId, lastTriggered);
                if (typeof originalOnStateChange === 'function') originalOnStateChange(state, item);
                if (stopped) return;
                if (state === 'playing' && !s && lastTriggered !== item?.messageId) {
                    console.log('[AutoTTS] 触发发送, msgId:', item?.messageId);
                    lastTriggered = item?.messageId;
                    send();
                }
            } catch (e) {
                console.error('[AutoTTS] TTS回调异常:', e);
            }
        };
    } else {
        console.warn('[AutoTTS] xiaobaixTts.player 不可用');
    }

    let rl = null;
    try {
        rl = addFloorListener((data) => {
            try {
                if (stopped) {
                    console.log('[AutoTTS] 已停止跳过');
                    return;
                }
                const id = data.messageId ?? (chat.length - 1);
                const msg = chat[id];
                console.log('[AutoTTS] AI回复完成, messageId:', id);

                if (cfg.mustContain && msg && !String(msg.mes || '').includes(cfg.mustContain)) {
                    if (retryCount < cfg.maxRetries) {
                        retryCount++;
                        console.log(`[AutoTTS] 不含"${cfg.mustContain}"，重试 ${retryCount}/${cfg.maxRetries}`);
                        showToast(`关键字检查未通过，正在重试(${retryCount}/${cfg.maxRetries})`);
                        clearTimeout(retryTimer);
                        retryTimer = setTimeout(() => {
                            console.warn('[AutoTTS] 重新生成超时，回退跳过检查');
                            retryCount = 0;
                            showToast('重新生成超时，继续循环');
                        }, 60000);
                        Generate('regenerate');
                        return;
                    }
                    console.warn(`[AutoTTS] 已达最大重试次数(${cfg.maxRetries})，跳过关键字检查继续循环`);
                    showToast(`关键字"${cfg.mustContain}"未匹配，重试已耗尽`);
                }
                clearTimeout(retryTimer);
                retryCount = 0;

                let retries = 0;
                const tryClick = () => {
                    const selector = `.mes[mesid="${id}"] .xb-tts-btn.play-btn`;
                    const btn = document.querySelector(selector);
                    if (btn) {
                        console.log('[AutoTTS] 找到TTS按钮，点击');
                        btn.click();
                    } else {
                        console.log(`[AutoTTS] 未找到按钮(retry ${retries}/10)`);
                        const mes = document.querySelector(`.mes[mesid="${id}"]`);
                        console.log('[AutoTTS] 消息元素:', mes ? '存在' : '不存在');
                        if (mes) {
                            const panel = mes.querySelector('.xb-tts-panel');
                            console.log('[AutoTTS] TTS面板:', panel ? '存在' : '不存在');
                        }
                        if (retries < 10) {
                            retries++;
                            setTimeout(tryClick, 300);
                        } else {
                            console.warn('[AutoTTS] 10次重试后仍找不到TTS按钮');
                        }
                    }
                };
                tryClick();
            } catch (e) {
                console.error('[AutoTTS] 回调异常:', e);
            }
        }, { interval: 1, timing: 'after_ai', floorType: 'llm' });
        console.log('[AutoTTS] addFloorListener 注册成功');
    } catch (e) {
        console.error('[AutoTTS] addFloorListener 注册失败:', e);
    }

    // ============ UI 面板 ============
    if (!document.getElementById('atts_styles')) {
        const ss = document.createElement('style');
        ss.id = 'atts_styles';
        ss.textContent = `
            #atts_panel{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:99999}
            #atts_panel .mask{position:absolute;inset:0;background:rgba(0,0,0,.5)}
            #atts_panel .card{position:relative;width:min(420px,92vw);background:var(--SmartThemeBlurTintColor,#1a1a1a);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:12px;display:flex;flex-direction:column;overflow:hidden}
            #atts_panel .head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--SmartThemeBorderColor,#333);background:rgba(0,0,0,.3)}
            #atts_panel .body{padding:16px;display:flex;flex-direction:column;gap:12px}
            #atts_panel .body label{color:#bbb;font-size:13px;display:block;margin-bottom:4px}
            #atts_panel .body input,#atts_panel .body textarea{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:8px;padding:8px 10px;color:var(--SmartThemeBodyColor,#e9e9e9);resize:vertical;font-size:14px}
            #atts_panel .body textarea{min-height:80px}
            .atts_btn{cursor:pointer;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:8px;padding:8px 16px;font-size:14px;color:var(--SmartThemeBodyColor,#e9e9e9);background:rgba(255,255,255,.08)}
            .atts_btn:hover{background:rgba(255,255,255,.15)}
            .atts_primary{background:var(--SmartThemeAccentColor,#3a6);border-color:var(--SmartThemeAccentColor,#3a6);color:#fff}
            .atts_ops{display:flex;gap:8px;margin-top:4px}
        `;
        document.head.appendChild(ss);
    }

    function buildPanel() {
        const existing = document.getElementById('atts_panel');
        if (existing) {
            existing.style.display = 'flex';
            return;
        }
        const root = document.createElement('div');
        root.id = 'atts_panel';
        root.innerHTML = `
            <div class="mask"></div>
            <div class="card">
                <div class="head">
                    <b>自动TTS设置</b>
                </div>
                <div class="body">
                    <div>
                        <label>自动发送文本</label>
                        <textarea id="atts_text">${esc(cfg.text)}</textarea>
                    </div>
                    <div>
                        <label>循环次数（0=无限）</label>
                        <input type="number" id="atts_loop" value="${cfg.maxLoop}" min="0" max="999" style="width:100px">
                    </div>
                    <div>
                        <label>必含关键字（空=不检查）</label>
                        <input type="text" id="atts_must" value="${esc(cfg.mustContain)}">
                    </div>
                    <div>
                        <label>最大重试次数</label>
                        <input type="number" id="atts_retry" value="${cfg.maxRetries}" min="0" max="99" style="width:100px">
                    </div>
                    <div class="atts_ops">
                        <button class="atts_btn atts_primary" id="atts_start">开始循环</button>
                        <button class="atts_btn" id="atts_stop">停止循环</button>
                        <button class="atts_btn" id="atts_close">关闭</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        document.getElementById('atts_close').onclick = () => {
            root.style.display = 'none';
        };
        document.getElementById('atts_start').onclick = () => {
            cfg.text = document.getElementById('atts_text').value;
            cfg.maxLoop = parseInt(document.getElementById('atts_loop').value) || 0;
            cfg.mustContain = document.getElementById('atts_must').value;
            cfg.maxRetries = parseInt(document.getElementById('atts_retry').value) || 3;
            retryCount = 0;
            loopCount = 0;
            saveCfg();
            root.style.display = 'none';
            stopped = false;
            lastTriggered = null;
            send();
        };
        document.getElementById('atts_stop').onclick = () => {
            stopped = true;
            s = false;
            lastTriggered = null;
            loopCount = 0;
            retryCount = 0;
            clearTimeout(retryTimer);
            root.style.display = 'none';
            showToast('循环已停止');
        };
        root.querySelector('.mask').onclick = () => {
            root.style.display = 'none';
        };
    }

    function openPanel() {
        buildPanel();
        document.getElementById('atts_panel').style.display = 'flex';
    }

    // ============ 启动：打开设置面板 ============
    openPanel();

    const cleanup = () => {
        window._running = false;
        delete window._cleanup;
        clearInterval(keepAlive);
        clearTimeout(retryTimer);
        rl?.();
        if (originalOnStateChange !== null && window.xiaobaixTts && window.xiaobaixTts.player) {
            window.xiaobaixTts.player.onStateChange = originalOnStateChange;
        }
        document.getElementById('atts_panel')?.remove();
        document.getElementById('atts_styles')?.remove();
        document.getElementById('atts_toast')?.remove();
    };
    window._cleanup = cleanup;

    return { cleanup };
})();
<</taskjs>>
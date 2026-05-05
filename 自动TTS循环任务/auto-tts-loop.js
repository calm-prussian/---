<<taskjs>>
(async () => {
    const prevState = window._atts_state || null;
    if (window._cleanup) {
        window._cleanup();
        delete window._cleanup;
        delete window._running;
    }
    window._running = true;

    const { chat, Generate } = await import('/script.js');

    let s = false;
    let lastTriggered = prevState?.lastTriggered ?? null;
    let loopCount = prevState?.loopCount ?? 0;
    let retryCount = prevState?.retryCount ?? 0;
    let stopped = prevState?.stopped ?? true;
    let retryTimer = null;
    const keepAlive = setInterval(() => {}, 60000);
    delete window._atts_state;

    let cfg = { text: '你好，请介绍一下自己。', maxLoop: 0, mustContain: '', maxRetries: 3, findBtnRetries: 10, skipOnBtnFail: true };
    const CFG_DEFAULTS = { text: '你好，请介绍一下自己。', maxLoop: 0, mustContain: '', maxRetries: 3, findBtnRetries: 10, skipOnBtnFail: true };

    try {
        const saved = localStorage.getItem('auto_tts_cfg');
        if (saved) Object.assign(cfg, JSON.parse(saved));
        if (!cfg.mustContain) cfg.mustContain = '';
        if (cfg.maxRetries === undefined) cfg.maxRetries = 3;
        if (cfg.findBtnRetries === undefined) cfg.findBtnRetries = 10;
        if (cfg.skipOnBtnFail === undefined) cfg.skipOnBtnFail = true;
    } catch {}

    function saveCfg() {
        localStorage.setItem('auto_tts_cfg', JSON.stringify(cfg));
    }

    function saveState() {
        window._atts_state = { lastTriggered, loopCount, retryCount, stopped };
    }

    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    async function send() {
        if (stopped) return;
        if (s) return;
        if (cfg.maxLoop > 0 && loopCount >= cfg.maxLoop) {
            console.log(`[AutoTTS] 达到最大循环次数(${cfg.maxLoop})，停止发送`);
            stopped = true;
            saveState();
            showToast(`已达最大循环次数(${cfg.maxLoop})`);
            return;
        }
        s = true;
        loopCount++;
        saveState();
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

    function findTtsBtn(id) {
        const maxRetries = cfg.findBtnRetries;
        return new Promise((resolve) => {
            const selector = `.mes[mesid="${id}"] .xb-tts-btn.play-btn`;
            const btn = document.querySelector(selector);
            if (btn) {
                console.log('[AutoTTS] 找到TTS按钮，点击');
                btn.click();
                resolve(true);
                return;
            }
            const mes = document.querySelector(`.mes[mesid="${id}"]`);
            if (!mes) {
                console.warn('[AutoTTS] 消息元素不存在，无法查找TTS按钮');
                resolve(false);
                return;
            }
            let observer = null;
            let pollTimer = null;
            let timedOut = false;

            const cleanup = () => {
                if (observer) observer.disconnect();
                if (pollTimer) clearTimeout(pollTimer);
            };

            observer = new MutationObserver(() => {
                if (timedOut) return;
                const b = mes.querySelector('.xb-tts-btn.play-btn');
                if (b) {
                    timedOut = true;
                    cleanup();
                    console.log('[AutoTTS] 找到TTS按钮(MutationObserver)，点击');
                    b.click();
                    resolve(true);
                }
            });
            observer.observe(mes, { childList: true, subtree: true });

            const timeout = maxRetries * 300 + 500;
            pollTimer = setTimeout(() => {
                if (timedOut) return;
                timedOut = true;
                cleanup();
                const b2 = mes.querySelector('.xb-tts-btn.play-btn');
                if (b2) {
                    console.log('[AutoTTS] 超时前最后检查找到TTS按钮，点击');
                    b2.click();
                    resolve(true);
                } else {
                    console.warn(`[AutoTTS] ${maxRetries}次查找超时后仍找不到TTS按钮`);
                    resolve(false);
                }
            }, timeout);
        });
    }

    let originalOnStateChange = null;

    if (window.xiaobaixTts && window.xiaobaixTts.player) {
        const p = window.xiaobaixTts.player;
        originalOnStateChange = p.onStateChange;
        p.onStateChange = (state, item) => {
            try {
                if (state === 'progress') return;
                console.log('[AutoTTS] TTS状态:', state, item?.messageId, lastTriggered);
                if (typeof originalOnStateChange === 'function') originalOnStateChange(state, item);
                if (stopped) return;
                if (state === 'playing' && !s && lastTriggered !== item?.messageId) {
                    console.log('[AutoTTS] 触发发送, msgId:', item?.messageId);
                    lastTriggered = item?.messageId;
                    saveState();
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
                    console.log('[AutoTTS] 已停止，仍阅读当前回复');
                    findTtsBtn(id);
                    return;
                }
                const id = data.messageId ?? (chat.length - 1);
                const msg = chat[id];
                console.log('[AutoTTS] AI回复完成, messageId:', id);

                if (cfg.mustContain && msg && !String(msg.mes || '').includes(cfg.mustContain)) {
                    if (retryCount < cfg.maxRetries) {
                        retryCount++;
                        lastTriggered = null;
                        saveState();
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

                findTtsBtn(id).then(found => {
                    if (!found && cfg.skipOnBtnFail) {
                        console.warn('[AutoTTS] TTS按钮未找到，跳过并发送下一条');
                        showToast('TTS按钮未找到，跳过此条');
                        lastTriggered = null;
                        saveState();
                        send();
                    }
                });
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
            #atts_panel .card{position:relative;width:min(420px,92vw);background:var(--SmartThemeBlurTintColor,#1a1a1a);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;max-height:90vh}
            #atts_panel .head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--SmartThemeBorderColor,#333);background:rgba(0,0,0,.3)}
            #atts_panel .body{padding:16px;display:flex;flex-direction:column;gap:14px;overflow-y:auto}
            #atts_panel .field{display:flex;flex-direction:column;gap:4px}
            #atts_panel .field-label{color:#bbb;font-size:12px;line-height:1.4}
            #atts_panel .field-num{width:auto;min-width:70px;max-width:100px;background:rgba(0,0,0,.3);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:6px;padding:6px 8px;color:var(--SmartThemeBodyColor,#e9e9e9);font-size:14px;text-align:center}
            #atts_panel .field-input{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:6px;padding:8px 10px;color:var(--SmartThemeBodyColor,#e9e9e9);font-size:14px;box-sizing:border-box}
            #atts_panel .field-textarea{width:100%;min-height:70px;background:rgba(0,0,0,.3);border:1px solid var(--SmartThemeBorderColor,#333);border-radius:6px;padding:8px 10px;color:var(--SmartThemeBodyColor,#e9e9e9);font-size:14px;resize:vertical;box-sizing:border-box}
            #atts_panel .field-hint{color:#666;font-size:11px;margin-top:1px}
            #atts_panel .check-row{display:flex;align-items:center;gap:8px}
            #atts_panel .check-row input[type=checkbox]{width:16px;height:16px;flex-shrink:0;accent-color:var(--SmartThemeAccentColor,#3a6);margin:0;cursor:pointer}
            #atts_panel .check-row .check-label{color:#bbb;font-size:13px;cursor:pointer;user-select:none;line-height:1.3}
            .atts_btn{cursor:pointer;border:1px solid var(--SmartThemeBorderColor,#333);border-radius:6px;padding:8px 16px;font-size:14px;color:var(--SmartThemeBodyColor,#e9e9e9);background:rgba(255,255,255,.08);transition:background .15s}
            .atts_btn:hover{background:rgba(255,255,255,.15)}
            .atts_primary{background:var(--SmartThemeAccentColor,#3a6);border-color:var(--SmartThemeAccentColor,#3a6);color:#fff}
            .atts_ops{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap}
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
                    <div class="field">
                        <div class="field-label">自动发送文本</div>
                        <textarea class="field-textarea" id="atts_text">${esc(cfg.text)}</textarea>
                    </div>
                    <div class="field">
                        <div class="field-label">循环次数（0 = 无限）</div>
                        <input type="number" class="field-num" id="atts_loop" value="${cfg.maxLoop}" min="0" max="999">
                    </div>
                    <div class="field">
                        <div class="field-label">必含关键字（空 = 不检查）</div>
                        <input type="text" class="field-input" id="atts_must" value="${esc(cfg.mustContain)}">
                    </div>
                    <div class="field">
                        <div class="field-label">关键字不匹配时最大重试次数</div>
                        <input type="number" class="field-num" id="atts_retry" value="${cfg.maxRetries}" min="0" max="99">
                    </div>
                    <div class="field">
                        <div class="field-label">查找TTS按钮重试次数</div>
                        <input type="number" class="field-num" id="atts_btn_retry" value="${cfg.findBtnRetries}" min="1" max="50">
                        <div class="field-hint">总超时 ≈ 次数 × 300ms，建议 10~20</div>
                    </div>
                    <div class="check-row">
                        <input type="checkbox" id="atts_skip_btn_fail" ${cfg.skipOnBtnFail ? 'checked' : ''}>
                        <label class="check-label" for="atts_skip_btn_fail">找不到TTS按钮时跳过并发送下一条</label>
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
            cfg.maxRetries = parseInt(document.getElementById('atts_retry').value);
            if (isNaN(cfg.maxRetries) || cfg.maxRetries < 0) cfg.maxRetries = 3;
            cfg.findBtnRetries = parseInt(document.getElementById('atts_btn_retry').value);
            if (isNaN(cfg.findBtnRetries) || cfg.findBtnRetries < 1) cfg.findBtnRetries = 10;
            cfg.skipOnBtnFail = document.getElementById('atts_skip_btn_fail').checked;
            retryCount = 0;
            loopCount = 0;
            saveCfg();
            root.style.display = 'none';
            stopped = false;
            lastTriggered = null;
            saveState();
            send();
        };
        document.getElementById('atts_stop').onclick = () => {
            stopped = true;
            s = false;
            lastTriggered = null;
            loopCount = 0;
            retryCount = 0;
            clearTimeout(retryTimer);
            saveState();
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

    // ============ 启动 ============
    if (stopped) {
        console.log('[AutoTTS] 首次启动或已停止，打开设置面板');
        openPanel();
    } else {
        console.log(`[AutoTTS] 恢复运行状态(第${loopCount}轮, 重试${retryCount}次)`);
    }

    const cleanup = () => {
        saveState();
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
<<taskjs>>
(async () => {
    if (window._cleanup) {
        window._cleanup();
        delete window._cleanup;
        delete window._r;
    }
    window._r = true;
    const { chat } = await import('/script.js');

    let s = false;
    let lastTriggered = null;
    let loopCount = 0;
    let stopped = false;
    const keepAlive = setInterval(() => {}, 60000);

    let cfg = { text: '你好，请介绍一下自己。', maxLoop: 0 };

    try {
        const saved = localStorage.getItem('auto_tts_cfg');
        if (saved) cfg = JSON.parse(saved);
    } catch {}

    function saveCfg() {
        localStorage.setItem('auto_tts_cfg', JSON.stringify(cfg));
    }

    async function send() {
        if (s) return;
        if (cfg.maxLoop > 0 && loopCount >= cfg.maxLoop) return;
        s = true;
        loopCount++;
        const t = document.getElementById('send_textarea');
        t.value = cfg.text;
        t.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        document.getElementById('send_but').click();
        setTimeout(() => { s = false; }, 500);
    }

    if (window.xiaobaixTts && window.xiaobaixTts.player) {
        const p = window.xiaobaixTts.player;
        const o = p.onStateChange;
        p.onStateChange = (state, item) => {
            if (typeof o === 'function') o(state, item);
            if (stopped) return;
            if (state === 'playing' && !s && lastTriggered !== item?.messageId) {
                lastTriggered = item?.messageId;
                send();
            }
        };
    }

    const rl = addFloorListener((data) => {
        if (stopped) return console.log('[AutoTTS] 已停止，跳过');
        const id = data.messageId ?? (chat.length - 1);
        console.log('[AutoTTS] AI回复完成, messageId:', id);
        let retries = 0;
        const tryClick = () => {
            const selector = `.mes[mesid="${id}"] .xb-tts-btn.play-btn`;
            const btn = document.querySelector(selector);
            if (btn) {
                console.log('[AutoTTS] 找到TTS按钮，点击');
                console.log('[AutoTTS] 按钮:', btn.outerHTML.substring(0, 100));
                btn.click();
            } else {
                console.log(`[AutoTTS] 未找到按钮(retry ${retries}/10), 检查元素是否存在...`);
                const mes = document.querySelector(`.mes[mesid="${id}"]`);
                console.log('[AutoTTS] 消息元素:', mes ? '存在' : '不存在');
                if (mes) {
                    const panel = mes.querySelector('.xb-tts-panel');
                    console.log('[AutoTTS] TTS面板:', panel ? '存在' : '不存在', panel?.innerHTML?.substring(0, 100));
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
    }, { interval: 1, timing: 'after_ai', floorType: 'llm' });

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
        if (document.getElementById('atts_panel')) return;
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
                        <textarea id="atts_text">${cfg.text}</textarea>
                    </div>
                    <div>
                        <label>循环次数（0=无限）</label>
                        <input type="number" id="atts_loop" value="${cfg.maxLoop}" min="0" max="999" style="width:100px">
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
            loopCount = 0;
            saveCfg();
            root.style.display = 'none';
            stopped = false;
            send();
        };
        document.getElementById('atts_stop').onclick = () => {
            stopped = true;
            s = false;
            lastTriggered = null;
            loopCount = 0;
            root.style.display = 'none';
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
        window._r = false;
        delete window._cleanup;
        clearInterval(keepAlive);
        rl();
        if (window.xiaobaixTts && window.xiaobaixTts.player) {
            window.xiaobaixTts.player.onStateChange = o;
        }
        document.getElementById('atts_panel')?.remove();
        document.getElementById('atts_styles')?.remove();
    };
    window._cleanup = cleanup;

    return { cleanup };
})();
<</taskjs>>

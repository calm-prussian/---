//name: TTS朗读助手
//author: Custom
//description: 手动/自动朗读AI回复
(function() {
    "use strict";

    var BTN_READ = '阅读';
    var BTN_SETTING = '设置';
    var PANEL_ID = 'ta2-panel';
    var PANEL_OVERLAY_ID = 'ta2-panel-overlay';
    var STYLE_ID = 'ta2-styles';
    var SETTINGS_KEY = 'ta_readonly_v1';

    var DEFAULTS = {
        autoRead: false,
        tts: { enabled: true, voice: 'female_1', rate: 0 },
        textFilter: { enabled: false, readEnabled: false, readRanges: [], skipEnabled: false, skipRanges: [] }
    };

    var EDGE_VOICES = [
        { key: 'female_1', name: '晓晓', tag: '温暖百变女声' },
        { key: 'male_1', name: '云希', tag: '少年温暖男声' },
        { key: 'female_2', name: '晓伊', tag: '女声' },
        { key: 'male_2', name: '云健', tag: '男声' },
        { key: 'female_3', name: '晓梦', tag: '女声' },
        { key: 'male_3', name: '云扬', tag: '男声' },
        { key: 'female_4', name: '晓涵', tag: '女声' },
        { key: 'male_4', name: '云峰', tag: '男声' },
        { key: 'hk_female_1', name: '晓佳(粤)', tag: '粤语女声' },
        { key: 'hk_female_2', name: '晓曼(粤)', tag: '粤语女声' },
        { key: 'hk_male_1', name: '云龙(粤)', tag: '粤语男声' },
        { key: 'tw_female_1', name: '晓臻(台)', tag: '台语女声' },
        { key: 'tw_female_2', name: '晓雨(台)', tag: '台语女声' },
        { key: 'tw_male_1', name: '云哲(台)', tag: '台语男声' },
        { key: 'en_female_1', name: 'Aria(EN)', tag: '英文女声' },
        { key: 'en_female_2', name: 'Jenny(EN)', tag: '英文女声' },
        { key: 'en_female_3', name: 'Ana(EN)', tag: '英文女声' },
        { key: 'en_male_1', name: 'Guy(EN)', tag: '英文男声' },
        { key: 'en_male_2', name: 'Eric(EN)', tag: '英文男声' },
        { key: 'ja_female_1', name: 'Nanami(JP)', tag: '日文女声' },
        { key: 'ja_male_1', name: 'Keita(JP)', tag: '日文男声' }
    ];

    // ============ 日志 ============
    var logBuf = [];
    function addLog(level, msg) {
        var entry = { t: new Date().toLocaleTimeString(), l: level, m: msg };
        logBuf.push(entry);
        if (logBuf.length > 500) logBuf.shift();
        console.log('[朗读助手][' + level + '] ' + msg);
    }

    // ============ 设置 ============
    var settings = {};
    function loadSettings() {
        try {
            var raw = localStorage.getItem(SETTINGS_KEY);
            settings = raw ? $.extend(true, {}, DEFAULTS, JSON.parse(raw)) : $.extend(true, {}, DEFAULTS);
        } catch (e) { settings = $.extend(true, {}, DEFAULTS); }
    }
    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
    }

    // ============ TTS ============
    var TTS_URL = 'https://edgetts.velure.codes/';

    async function ttsSingle(text, voice, rate) {
        var speed = 1.0 + (rate || 0) / 100;
        if (speed < 0.5) speed = 0.5;
        if (speed > 2.0) speed = 2.0;
        var r = await window.parent.fetch(TTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voiceKey: voice, text: text, speed: speed, uid: 'tr_' + Date.now(), reqid: 'tr-' + Date.now() })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var data = await r.json();
        if (!data.data) throw new Error('无音频数据');
        var raw = atob(data.data);
        var bytes = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return new Blob([bytes], { type: 'audio/mpeg' });
    }

    async function synTTS(text, voice, rate) {
        if (text.length <= 3000) return await ttsSingle(text, voice, rate);
        var parts = text.match(/[^。！？!?.\n]+[。！？!?.\n]?/g) || [text];
        var chunks = [], cur = '';
        for (var i = 0; i < parts.length; i++) {
            if (cur.length + parts[i].length > 3000 && cur) { chunks.push(cur.trim()); cur = ''; }
            cur += parts[i];
        }
        if (cur.trim()) chunks.push(cur.trim());
        var blobs = [];
        for (var j = 0; j < chunks.length; j++) blobs.push(await ttsSingle(chunks[j], voice, rate));
        return new Blob(blobs, { type: 'audio/mpeg' });
    }

    // ============ IndexedDB 缓存 ============
    var DB = null;
    function openDB() {
        if (DB) return Promise.resolve(DB);
        return new Promise(function(resolve) {
            var req = indexedDB.open('ta2-tts', 1);
            req.onupgradeneeded = function(e) { e.target.result.createObjectStore('tts', { keyPath: 'k' }); };
            req.onsuccess = function(e) { DB = e.target.result; resolve(DB); };
            req.onerror = function() { resolve(null); };
        });
    }
    function cKey(text, voice, rate) {
        var p = voice + '|' + (rate || 0) + '|' + text, h = 0;
        for (var i = 0; i < p.length; i++) h = ((h << 5) - h) + p.charCodeAt(i);
        return 't2:' + h;
    }
    async function getCached(key) {
        try {
            var db = await openDB();
            if (!db) return null;
            return new Promise(function(resolve) {
                var req = db.transaction('tts', 'readonly').objectStore('tts').get(key);
                req.onsuccess = function() { var e = req.result; resolve(e && Date.now() - e.t < 604800000 ? e.b : null); };
                req.onerror = function() { resolve(null); };
            });
        } catch (e) { return null; }
    }
    async function setCached(key, blob) {
        try {
            var db = await openDB();
            if (!db) return;
            return new Promise(function(resolve) {
                var tx = db.transaction('tts', 'readwrite');
                tx.objectStore('tts').put({ k: key, b: blob, t: Date.now() });
                tx.oncomplete = resolve; tx.onerror = resolve;
            });
        } catch (e) {}
    }

    // ============ 播放器 ============
    function AudioQ() {
        this.q = []; this.cur = null; this.a = null; this.p = false;
    }
    AudioQ.prototype.enqueue = function(item) {
        if (!item || !item.blob) return false;
        for (var i = 0; i < this.q.length; i++) if (this.q[i].id === item.id) return false;
        if (this.cur && this.cur.id === item.id) return false;
        this.q.push(item);
        if (!this.p) this._next();
        return true;
    };
    AudioQ.prototype.clear = function() { this.q = []; this._stop(); this.cur = null; this.p = false; };
    AudioQ.prototype._next = function() {
        if (!this.q.length) { this.p = false; this.cur = null; hideNowPlaying(); return; }
        this._play(this.q.shift());
    };
    AudioQ.prototype._play = function(item) {
        this.p = true; this.cur = item;
        showNowPlaying(item);
        var url = URL.createObjectURL(item.blob), a = new Audio(url), self = this;
        this.a = a;
        var done = function() { URL.revokeObjectURL(url); a.onended = a.onerror = null; self.a = null; };
        a.onended = function() { var ci = self.cur; done(); self._next(); };
        a.onerror = function() { var ci = self.cur; done(); self._next(); };
        a.play().catch(function() {});
    };
    AudioQ.prototype._stop = function() { if (this.a) { this.a.pause(); this.a.src = ''; this.a = null; } hideNowPlaying(); };

    // ============ 文本过滤 ============
    function stripHtml(s) { return s ? s.replace(/<[^>]*>/g, '') : ''; }
    function findSecs(text, ranges) {
        var secs = [];
        for (var r = 0; r < ranges.length; r++) {
            var st = (ranges[r].start || '').trim(), et = (ranges[r].end || '').trim();
            if (!st && !et) { secs.push({ s: 0, e: text.length }); continue; }
            var sp = 0;
            while (sp < text.length) {
                var ss = st ? text.indexOf(st, sp) : 0;
                if (ss === -1) break;
                sp = st ? ss + st.length : ss + 1;
                var se = et ? text.indexOf(et, sp) : text.length;
                if (se === -1) se = text.length; else se += et.length;
                if (se <= ss) { sp = Math.max(sp, se); if (!st) break; continue; }
                secs.push({ s: ss, e: se });
                if (!st) break;
                sp = se;
            }
        }
        return secs;
    }
    function mergeSecs(secs) {
        if (!secs.length) return [];
        secs.sort(function(a, b) { return a.s - b.s; });
        var m = [];
        for (var i = 0; i < secs.length; i++) {
            if (m.length && m[m.length - 1].e >= secs[i].s) m[m.length - 1].e = Math.max(m[m.length - 1].e, secs[i].e);
            else m.push({ s: secs[i].s, e: secs[i].e });
        }
        return m;
    }
    function applyRead(text, ranges) {
        if (!ranges.length) return text;
        var secs = mergeSecs(findSecs(text, ranges));
        if (!secs.length || (secs.length === 1 && secs[0].s === 0 && secs[0].e === text.length)) return text;
        var r = '';
        for (var i = 0; i < secs.length; i++) r += text.slice(secs[i].s, secs[i].e);
        return r;
    }
    function applySkip(text, ranges) {
        if (!ranges.length) return text;
        var secs = mergeSecs(findSecs(text, ranges));
        if (!secs.length) return text;
        var r = '', p = 0;
        for (var i = 0; i < secs.length; i++) { if (secs[i].s > p) r += text.slice(p, secs[i].s); p = secs[i].e; }
        if (p < text.length) r += text.slice(p);
        return r;
    }
    function filterText(text, cfg) {
        if (!text) return '';
        var r = text;
        if (cfg.readOn && cfg.read.length) r = applyRead(r, cfg.read);
        if (cfg.skipOn && cfg.skip.length) r = applySkip(r, cfg.skip);
        r = stripHtml(r);
        return r.trim();
    }

    // ============ 状态 ============
    var player = null, procIds = {};
    var panelOpen = false, currentTab = 'control';

    function getLatestAI() {
        try {
            var msgs = window.TavernHelper.getChatMessages('-1');
            if (msgs) for (var i = 0; i < msgs.length; i++) if (msgs[i].role === 'assistant') return msgs[i];
        } catch (e) {}
        return null;
    }

    function readLatest() {
        var msg = getLatestAI();
        if (!msg) { addLog('warn', '没有AI消息'); toastr && toastr.warning && toastr.warning('没有AI消息可朗读', 'TTS朗读助手'); return; }
        var mid = msg.message_id;
        if (procIds[mid]) { addLog('info', '消息 #' + mid + ' 已在处理中'); return; }
        procIds[mid] = true;
        var raw = msg.message || '';
        addLog('info', '手动朗读 #' + mid + ' (' + raw.length + '字)');
        try {
            if (settings.tts.enabled) {
                var fc = settings.textFilter;
                var text = filterText(raw, { readOn: fc.enabled && fc.readEnabled, read: fc.readRanges || [], skipOn: fc.enabled && fc.skipEnabled, skip: fc.skipRanges || [] });
                if (text) {
                    if (text.length !== raw.length) addLog('info', '过滤 ' + raw.length + '→' + text.length + '字');
                    doTTS(mid, text);
                } else { addLog('warn', '过滤后为空，跳过'); }
            }
        } catch (e) { addLog('error', '朗读失败: ' + e.message); }
        finally { delete procIds[mid]; }
    }

    function processAI(msg) {
        if (!msg || !msg.message || !msg.message.trim()) return;
        var mid = msg.message_id;
        if (procIds[mid]) return;
        procIds[mid] = true;
        var raw = msg.message;
        addLog('info', '自动朗读 #' + mid + ' (' + raw.length + '字)');
        try {
            if (settings.tts.enabled) {
                var fc = settings.textFilter;
                var text = filterText(raw, { readOn: fc.enabled && fc.readEnabled, read: fc.readRanges || [], skipOn: fc.enabled && fc.skipEnabled, skip: fc.skipRanges || [] });
                if (text) {
                    if (text.length !== raw.length) addLog('info', '过滤 ' + raw.length + '→' + text.length + '字');
                    doTTS(mid, text);
                }
            }
        } catch (e) { addLog('error', '朗读失败: ' + e.message); }
        finally { delete procIds[mid]; }
    }

    var msgDebounce = null;
    function onMsgReceived() {
        if (!settings.autoRead) return;
        if (msgDebounce) clearTimeout(msgDebounce);
        msgDebounce = setTimeout(function() {
            msgDebounce = null;
            var m = getLatestAI();
            if (m) processAI(m);
        }, 300);
    }

    async function doTTS(mid, text) {
        var voice = settings.tts.voice || 'female_1', rate = settings.tts.rate || 0;
        addLog('tts', '合成 #' + mid + ' (' + text.length + '字)...');
        var key = cKey(text, voice, rate);
        try {
            var blob = await getCached(key);
            if (blob) {
                updateNowPlaying('<span>📦</span><span> #' + mid + '</span><span> 缓存读取...</span>');
                addLog('tts', '✓ #' + mid + ' 命中缓存');
            } else {
                updateNowPlaying('<span>⏳</span><span> #' + mid + '</span><span> 合成中...</span>');
                blob = await synTTS(text, voice, rate);
                setCached(key, blob).catch(function() {});
            }
            player.enqueue({ id: 'msg-' + mid, blob: blob, text: text });
            addLog('tts', '✓ #' + mid + ' 入队');
        } catch (e) {
            addLog('error', 'TTS失败 #' + mid + ': ' + e.message);
            hideNowPlaying();
        }
    }

    // ============ 测试TTS ============
    async function testTTS() {
        addLog('info', '===== 测试TTS =====');
        var msg = getLatestAI();
        if (!msg) { addLog('warn', '没有AI消息'); return; }
        var raw = msg.message || '';
        var fc = settings.textFilter;
        var text = filterText(raw, { readOn: fc.enabled && fc.readEnabled, read: fc.readRanges || [], skipOn: fc.enabled && fc.skipEnabled, skip: fc.skipRanges || [] });
        if (!text) { addLog('warn', '过滤后为空'); return; }
        var voice = settings.tts.voice || 'female_1', rate = settings.tts.rate || 0;
        addLog('tts', '测试: 合成 (' + voice + ')...');
        try {
            var blob = await synTTS(text, voice, rate);
            player.enqueue({ id: 'test-' + Date.now(), blob: blob, text: text });
            addLog('tts', '✓ 测试成功');
            toastr && toastr.success && toastr.success('TTS朗读已开始', 'TTS朗读助手');
        } catch (e) {
            addLog('error', '测试失败: ' + e.message);
            toastr && toastr.warning && toastr.warning('TTS失败: ' + e.message, 'TTS朗读助手');
        }
    }

    // ============ UI ============
    function PD() { return window.parent.document; }

    function showNowPlaying(item) {
        var el = PD().getElementById('ta2-now-playing');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ta2-now-playing';
            $(PD().body).append(el);
        }
        var mid = '';
        if (item && item.id) mid = ' #' + String(item.id).replace('msg-', '');
        var preview = '';
        if (item && item.text) preview = item.text.replace(/[\r\n]/g, ' ').slice(0, 28);
        el.innerHTML = '<span>🔊</span><span>' + mid + '</span><span> ' + escH(preview) + (item && item.text && item.text.length > 28 ? '...' : '') + '</span>';
        el.classList.add('visible');
    }

    function updateNowPlaying(html) {
        var el = PD().getElementById('ta2-now-playing');
        if (!el) { el = document.createElement('div'); el.id = 'ta2-now-playing'; $(PD().body).append(el); }
        el.innerHTML = html;
        el.classList.add('visible');
    }

    function hideNowPlaying() {
        var el = PD().getElementById('ta2-now-playing');
        if (el) el.classList.remove('visible');
    }

    function injectStyles() {
        if (PD().getElementById(STYLE_ID)) return;
        var style = PD().createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '#ta2-panel-overlay{display:none;position:fixed;z-index:99996;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4)}' +
            '#ta2-panel-overlay.visible{display:block}' +
            '#ta2-panel{position:fixed;z-index:99997;top:50%;left:50%;transform:translate(-50%,-50%);width:480px;max-height:85vh;background:#1e1e2e;border:1px solid #444;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:none;flex-direction:column;overflow:hidden;color:#ddd;font-size:14px}' +
            '#ta2-panel.visible{display:flex}' +
            '#ta2-panel-header{padding:14px 18px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:16px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}' +
            '#ta2-panel-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0 4px}' +
            '.ta2-tabs{display:flex;border-bottom:1px solid #444}' +
            '.ta2-tab{padding:8px 16px;cursor:pointer;font-size:13px;color:#888;border-bottom:2px solid transparent;transition:.2s;position:relative}' +
            '.ta2-tab:hover{color:#ccc}' +
            '.ta2-tab.active{color:#667eea;border-bottom-color:#667eea}' +
            '.ta2-tab .ta2-badge{position:absolute;top:2px;right:2px;background:#e74c3c;color:#fff;font-size:10px;border-radius:8px;padding:0 5px;line-height:16px;min-width:16px;text-align:center}' +
            '#ta2-panel-body{padding:16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px}' +
            '.ta2-section{border:1px solid #444;border-radius:8px;padding:12px}' +
            '.ta2-section-title{font-size:14px;font-weight:bold;margin-bottom:10px;color:#667eea;display:flex;align-items:center;gap:8px}' +
            '.ta2-toggle{position:relative;display:inline-block;width:40px;height:22px;margin-left:auto}' +
            '.ta2-toggle input{opacity:0;width:0;height:0}' +
            '.ta2-toggle .ta2-toggle-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#555;border-radius:22px;transition:.3s}' +
            '.ta2-toggle .ta2-toggle-slider::before{content:"";position:absolute;width:16px;height:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}' +
            '.ta2-toggle input:checked+.ta2-toggle-slider{background:#667eea}' +
            '.ta2-toggle input:checked+.ta2-toggle-slider::before{transform:translateX(18px)}' +
            '.ta2-form-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}' +
            '.ta2-form-row label{min-width:50px;font-size:13px;white-space:nowrap}' +
            '.ta2-form-row select,.ta2-form-row input[type=number],.ta2-form-row input[type=text]{flex:1;background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 8px;font-size:13px}' +
            '.ta2-form-row input[type=range]{flex:1}' +
            '#ta2-panel .ta2-range-row input[type=text]{flex:1;min-width:0;background:#2a2a3a!important;color:#ccc!important;border:1px solid #555!important;border-radius:4px;padding:3px 6px;font-size:12px}' +
            '.ta2-range-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:4px 6px;background:rgba(255,255,255,.03);border-radius:4px}' +
            '.ta2-range-row .ta2-sep{color:#888}' +
            '.ta2-btn{background:#667eea;color:#fff;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:13px}' +
            '.ta2-btn:hover{background:#5a6fd6}' +
            '.ta2-btn-sm{padding:2px 8px;font-size:12px}' +
            '.ta2-btn-danger{background:#e74c3c}' +
            '.ta2-btn-danger:hover{background:#c0392b}' +
            '.ta2-btn-group{display:flex;gap:8px;margin-top:4px;align-items:center}' +
            '.ta2-hint{font-size:11px;color:#888;margin-top:2px}' +
            '.ta2-disabled{opacity:.5;pointer-events:none}' +
            '.ta2-rate-val{min-width:36px;text-align:center;font-size:13px}' +
            '.ta2-read-btn{width:100%;padding:12px;font-size:15px;font-weight:bold;border-radius:8px;cursor:pointer;border:none;background:#4ecdc4;color:#1e1e2e}' +
            '.ta2-read-btn:hover{opacity:.9}' +
            '.ta2-log-entry{display:flex;gap:8px;padding:3px 0;font-size:12px;font-family:monospace;border-bottom:1px solid rgba(255,255,255,.03)}' +
            '.ta2-log-time{color:#888;white-space:nowrap;min-width:70px}' +
            '.ta2-log-icon{width:18px;text-align:center}' +
            '.ta2-log-msg{word-break:break-all;flex:1}' +
            '.ta2-log-tts{color:#667eea}.ta2-log-info{color:#888}.ta2-log-warn{color:#f0ad4e}.ta2-log-error{color:#e74c3c}' +
            '#ta2-now-playing{position:fixed;right:20px;bottom:20px;z-index:99995;background:rgba(30,30,46,.92);border:1px solid #667eea;border-radius:8px;padding:8px 14px;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;opacity:0;transform:translateY(10px);transition:opacity .3s,transform .3s;pointer-events:none;max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '#ta2-now-playing.visible{opacity:1;transform:translateY(0)}' +
            '@media(max-width:540px){#ta2-panel{width:96vw;max-width:480px;max-height:92vh}#ta2-panel-body{padding:10px;font-size:13px}.ta2-section{padding:10px}.ta2-range-row{flex-wrap:wrap}.ta2-range-row input[type=text]{min-width:60px}#ta2-now-playing{right:8px;bottom:8px;max-width:80vw;font-size:12px;padding:6px 10px}}';
        PD().head.appendChild(style);
    }

    function createOverlay() {
        if (PD().getElementById(PANEL_OVERLAY_ID)) return;
        var o = document.createElement('div');
        o.id = PANEL_OVERLAY_ID;
        o.addEventListener('click', closePanel);
        $(PD().body).append(o);
    }

    function createPanel() {
        if (PD().getElementById(PANEL_ID)) return;
        var p = document.createElement('div');
        p.id = PANEL_ID;
        var h = document.createElement('div');
        h.id = 'ta2-panel-header';
        h.innerHTML = '<span>🎛 TTS朗读助手</span>';
        var cb = document.createElement('button');
        cb.id = 'ta2-panel-close';
        cb.textContent = '✕';
        cb.addEventListener('click', closePanel);
        h.appendChild(cb);
        var b = document.createElement('div');
        b.id = 'ta2-panel-body';
        p.appendChild(h); p.appendChild(b);
        $(PD().body).append(p);
        makePanelDraggable(p, h);
    }

    function makePanelDraggable(panel, handle) {
        var ox = 0, oy = 0, dg = false;
        $(handle).on('mousedown', function(e) {
            if (e.target === PD().getElementById('ta2-panel-close')) return;
            dg = true; var r = panel.getBoundingClientRect();
            ox = e.clientX - r.left; oy = e.clientY - r.top;
            $(panel).css('transform', 'none');
        });
        $(PD()).on('mousemove.tap2', function(e) {
            if (!dg) return;
            var pw = panel.offsetWidth, ph = panel.offsetHeight;
            var maxX = Math.max(0, window.parent.innerWidth - 40);
            var maxY = Math.max(0, window.parent.innerHeight - 20);
            $(panel).css({ left: Math.max(20 - pw, Math.min(maxX, e.clientX - ox)) + 'px', top: Math.max(-20, Math.min(maxY, e.clientY - oy)) + 'px' });
        });
        $(PD()).on('mouseup.tap2', function() { dg = false; });
    }

    function openPanel() {
        panelOpen = true;
        createOverlay();
        createPanel();
        var p = $(PD().getElementById(PANEL_ID));
        if (p.length) p.css({ left: '', top: '', transform: '' });
        $(PD().getElementById(PANEL_OVERLAY_ID)).addClass('visible');
        $(PD().getElementById(PANEL_ID)).addClass('visible');
        currentTab = 'control';
        refreshPanel();
    }

    function closePanel() {
        panelOpen = false;
        $(PD().getElementById(PANEL_OVERLAY_ID)).removeClass('visible');
        $(PD().getElementById(PANEL_ID)).removeClass('visible');
    }

    function escH(s) { return $('<div>').text(s || '').html(); }
    function rRanges(ranges, type) {
        if (!ranges.length) return '<div class="ta2-hint">无</div>';
        return ranges.map(function(r, i) {
            return '<div class="ta2-range-row" data-idx="' + i + '" data-type="' + type + '">' +
                '<input class="ta2-range-start" value="' + escH(r.start || '') + '" placeholder="起始">' +
                '<span class="ta2-sep">→</span>' +
                '<input class="ta2-range-end" value="' + escH(r.end || '') + '" placeholder="结束">' +
                '<button class="ta2-btn ta2-btn-sm ta2-btn-danger ta2-rm-range">✕</button></div>';
        }).join('');
    }

    function badLogCount() {
        var c = 0;
        for (var i = 0; i < logBuf.length; i++) { if (logBuf[i].l === 'warn' || logBuf[i].l === 'error') c++; }
        return c;
    }

    function iconFor(l) {
        if (l === 'tts') return '🔊';
        if (l === 'warn') return '⚠️';
        if (l === 'error') return '❌';
        return 'ℹ️';
    }

    function renderControlTab(s) {
        var vopts = EDGE_VOICES.map(function(v) { return '<option value="' + escH(v.key) + '"' + (s.tts.voice === v.key ? ' selected' : '') + '>' + escH(v.name) + ' (' + escH(v.tag) + ')</option>'; }).join('');
        return '<div style="text-align:center;margin-bottom:4px;">' +
            '<div class="ta2-form-row"><span style="font-size:14px;">自动朗读</span><label class="ta2-toggle"><input class="ta2-auto-read" type="checkbox"' + (s.autoRead ? ' checked' : '') + '><span class="ta2-toggle-slider"></span></label></div>' +
            '<button class="ta2-read-btn ta2-read-latest">🔘 朗读最近一楼</button></div>' +
            '<div class="ta2-section"><div class="ta2-section-title">🔊 TTS</div>' +
            '<div class="ta2-form-row"><label>音色</label><select class="ta2-tts-voice">' + vopts + '</select></div>' +
            '<div class="ta2-form-row"><label>语速</label><input class="ta2-tts-rate" type="range" min="-50" max="100" value="' + (s.tts.rate || 0) + '"><span class="ta2-rate-val">' + (s.tts.rate || 0) + '%</span></div></div>' +
            '<div class="ta2-section"><div class="ta2-section-title"><span>✂ 文本过滤</span><label class="ta2-toggle"><input class="ta2-f-toggle" type="checkbox"' + (s.textFilter.enabled ? ' checked' : '') + '><span class="ta2-toggle-slider"></span></label></div>' +
            '<div class="' + (s.textFilter.enabled ? '' : 'ta2-disabled') + '">' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:4px;"><input class="ta2-read-on" type="checkbox"' + (s.textFilter.readEnabled ? ' checked' : '') + '><b>只读区间</b><span class="ta2-hint">(先于跳过执行)</span></label>' +
            '<div class="ta2-hint">起始留空=从头读，结束留空=读到末尾</div><div class="ta2-read-ranges">' + rRanges(s.textFilter.readRanges || [], 'read') + '</div>' +
            '<button class="ta2-btn ta2-btn-sm ta2-add-read">＋ 添加只读区间</button>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;margin-bottom:4px;"><input class="ta2-skip-on" type="checkbox"' + (s.textFilter.skipEnabled ? ' checked' : '') + '><b>跳过区间</b><span class="ta2-hint">(只读之后执行)</span></label>' +
            '<div class="ta2-hint">起始留空=从头跳，结束留空=跳到末尾</div><div class="ta2-skip-ranges">' + rRanges(s.textFilter.skipRanges || [], 'skip') + '</div>' +
            '<button class="ta2-btn ta2-btn-sm ta2-add-skip">＋ 添加跳过区间</button></div></div>' +
            '<div class="ta2-btn-group"><button class="ta2-btn ta2-test-btn">🔊 测试TTS</button><div style="flex:1"></div><button class="ta2-btn ta2-save-btn">💾 保存</button><button class="ta2-btn ta2-reset-btn">🔄 重置</button></div>';
    }

    function renderLogTab() {
        var bc = badLogCount();
        var html = '<div class="ta2-btn-group" style="margin-bottom:8px;">' +
            '<button class="ta2-btn ta2-btn-sm ta2-log-copy">📋 复制全部</button>' +
            '<button class="ta2-btn ta2-btn-sm ta2-btn-danger ta2-log-clear">🗑 清空</button>' +
            '<span style="color:#888;font-size:12px;margin-left:auto;">共 ' + logBuf.length + ' 条' + (bc > 0 ? '，' + bc + ' 条异常' : '') + '</span></div>';
        if (!logBuf.length) { html += '<div class="ta2-hint">暂无日志</div>'; return html; }
        for (var i = logBuf.length - 1; i >= 0; i--) {
            var e = logBuf[i];
            html += '<div class="ta2-log-entry">' +
                '<span class="ta2-log-time">' + escH(e.t) + '</span>' +
                '<span class="ta2-log-icon">' + iconFor(e.l) + '</span>' +
                '<span class="ta2-log-msg ta2-log-' + e.l + '">' + escH(e.m) + '</span></div>';
        }
        return html;
    }

    function refreshPanel() {
        if (!panelOpen) return;
        var panel = PD().getElementById(PANEL_ID);
        if (!panel) return;
        var body = panel.querySelector('#ta2-panel-body');
        if (!body) return;
        var s = settings;
        var bc = badLogCount();
        $(body).html(
            '<div class="ta2-tabs">' +
            '<div class="ta2-tab' + (currentTab === 'control' ? ' active' : '') + ' ta2-tab-ctl">控制</div>' +
            '<div class="ta2-tab' + (currentTab === 'log' ? ' active' : '') + ' ta2-tab-log">日志' + (bc > 0 ? '<span class="ta2-badge">' + bc + '</span>' : '') + '</div></div>' +
            '<div class="ta2-tab-content">' + (currentTab === 'control' ? renderControlTab(s) : renderLogTab()) + '</div>'
        );
        bindPanel();
    }

    function bindPanel() {
        var b = $(PD().getElementById(PANEL_ID)).find('#ta2-panel-body');
        b.find('.ta2-tab-ctl').click(function() { currentTab = 'control'; refreshPanel(); });
        b.find('.ta2-tab-log').click(function() { currentTab = 'log'; refreshPanel(); });
        b.find('.ta2-log-copy').click(function() {
            var text = logBuf.map(function(e) { return '[' + e.t + '] [' + e.l + '] ' + e.m; }).join('\n');
            window.parent.navigator.clipboard.writeText(text).then(function() { toastr && toastr.success && toastr.success('已复制', 'TTS朗读助手'); });
        });
        b.find('.ta2-log-clear').click(function() { logBuf = []; refreshPanel(); });

        if (currentTab !== 'control') return;

        b.find('.ta2-auto-read').change(function() { settings.autoRead = this.checked; saveSettings(); });
        b.find('.ta2-read-latest').click(function() { readLatest(); });
        b.find('.ta2-tts-voice').change(function() { settings.tts.voice = this.value; saveSettings(); });
        b.find('.ta2-tts-rate').on('input', function() { settings.tts.rate = parseInt(this.value, 10); b.find('.ta2-rate-val').text(this.value + '%'); saveSettings(); });
        b.find('.ta2-f-toggle').change(function() { settings.textFilter.enabled = this.checked; saveSettings(); refreshPanel(); });
        b.find('.ta2-read-on').change(function() { settings.textFilter.readEnabled = this.checked; saveSettings(); });
        b.find('.ta2-skip-on').change(function() { settings.textFilter.skipEnabled = this.checked; saveSettings(); });
        b.find('.ta2-add-read').click(function() { if (!Array.isArray(settings.textFilter.readRanges)) settings.textFilter.readRanges = []; settings.textFilter.readRanges.push({ start: '', end: '' }); saveSettings(); refreshPanel(); });
        b.find('.ta2-add-skip').click(function() { if (!Array.isArray(settings.textFilter.skipRanges)) settings.textFilter.skipRanges = []; settings.textFilter.skipRanges.push({ start: '', end: '' }); saveSettings(); refreshPanel(); });
        b.on('click', '.ta2-rm-range', function() { var row = $(this).closest('.ta2-range-row'); var idx = parseInt(row.attr('data-idx'), 10); var t = row.attr('data-type'); var arr = t === 'read' ? settings.textFilter.readRanges : settings.textFilter.skipRanges; if (arr) arr.splice(idx, 1); saveSettings(); refreshPanel(); });
        b.on('input', '.ta2-range-start, .ta2-range-end', function() { var row = $(this).closest('.ta2-range-row'); var idx = parseInt(row.attr('data-idx'), 10); var t = row.attr('data-type'); var arr = t === 'read' ? settings.textFilter.readRanges : settings.textFilter.skipRanges; if (arr && arr[idx]) { arr[idx].start = row.find('.ta2-range-start').val() || ''; arr[idx].end = row.find('.ta2-range-end').val() || ''; saveSettings(); } });
        b.find('.ta2-test-btn').click(function() { testTTS(); });
        b.find('.ta2-save-btn').click(function() { saveSettings(); closePanel(); toastr && toastr.success && toastr.success('已保存', 'TTS朗读助手'); });
        b.find('.ta2-reset-btn').click(function() { settings = $.extend(true, {}, DEFAULTS); saveSettings(); refreshPanel(); toastr && toastr.info && toastr.info('已重置', 'TTS朗读助手'); });
    }

    // ============ 键盘 ============
    $(PD()).on('keydown.ta2', function(e) { if (e.key === 'Escape' && panelOpen) closePanel(); });

    // ============ 初始化 ============
    function initOnce() {
        loadSettings();
        injectStyles();
        createOverlay();
        createPanel();
        player = new AudioQ();
        window.eventOn(window.tavern_events.MESSAGE_RECEIVED, onMsgReceived);
        addLog('info', '初始化完毕，自动朗读: ' + (settings.autoRead ? '开' : '关'));
    }

    function register() {
        if (typeof getButtonEvent !== 'function') { setTimeout(register, 1000); return; }
        if (window._ta2_registered) return;
        window._ta2_registered = true;
        initOnce();

        eventOn(getButtonEvent(BTN_READ), function() {
            if (settings.autoRead) {
                settings.autoRead = false;
                saveSettings();
                addLog('info', '自动朗读已关闭');
                toastr && toastr.info && toastr.info('自动朗读已关闭', 'TTS朗读助手');
            } else {
                readLatest();
            }
        });

        eventOn(getButtonEvent(BTN_SETTING), function() {
            if (!panelOpen) openPanel();
        });

        addLog('info', '已注册: [阅读] + [设置]');
    }

    register();
})();

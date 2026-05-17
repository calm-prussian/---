//name: TTS自动循环
//author: Custom
//description: TTS朗读 + 自动发送 + 文本过滤 + 文本重发
(function() {
    "use strict";

    var BTN_NAME = '设置';
    var BTN_READ = '阅读';
    var PANEL_ID = 'ta-panel';
    var PANEL_OVERLAY_ID = 'ta-panel-overlay';
    var STYLE_ID = 'ta-styles';
    var SETTINGS_KEY = 'ta_assistant_v2';

    var DEFAULTS = {
        running: false,
        autoRead: false,
        autoSend: { enabled: true, text: '继续', maxRounds: 0, optionMode: 'fixed', optionIndex: 1 },
        tts: { enabled: true, voice: 'female_1', rate: 0 },
        textFilter: { enabled: false, readEnabled: false, readRanges: [], skipEnabled: false, skipRanges: [] },
        regexFilter: { enabled: false, disabledIds: [] },
        textResend: { enabled: false, requiredTags: [], maxRetries: 3, retryDelay: 500 }
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

    // ============ 日志系统 ============
    var logBuf = [];
    function addLog(level, msg) {
        var entry = { t: new Date().toLocaleTimeString(), l: level, m: msg };
        logBuf.push(entry);
        if (logBuf.length > 500) logBuf.shift();
        var prefix = '[TTS助手][' + level + ']';
        console.log(prefix + ' ' + msg);
        if (level === 'error' || level === 'warn') {
            toastr && toastr[level === 'error' ? 'warning' : 'info'] && toastr[level === 'error' ? 'warning' : 'info'](msg, 'TTS自动循环');
        }
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
            body: JSON.stringify({ voiceKey: voice, text: text, speed: speed, uid: 'ta_' + Date.now(), reqid: 'ta-' + Date.now() })
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
            var req = indexedDB.open('ta-tts', 1);
            req.onupgradeneeded = function(e) { e.target.result.createObjectStore('tts', { keyPath: 'k' }); };
            req.onsuccess = function(e) { DB = e.target.result; resolve(DB); };
            req.onerror = function() { resolve(null); };
        });
    }
    function cKey(text, voice, rate) {
        var p = voice + '|' + (rate || 0) + '|' + text, h = 0;
        for (var i = 0; i < p.length; i++) h = ((h << 5) - h) + p.charCodeAt(i);
        return 'tts:' + h;
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
    function AudioQ(onStart) {
        this.q = []; this.cur = null; this.a = null; this.p = false; this._s = onStart || null;
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
        if (this._s) this._s(item);
        a.play().catch(function() { done(); self._next(); });
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
    function filterText(text, cfg, skipStrip) {
        if (!text) return '';
        var r = text;
        if (cfg.skipOn && cfg.skip.length) r = applySkip(r, cfg.skip);
        if (cfg.readOn && cfg.read.length) r = applyRead(r, cfg.read);
        if (skipStrip) return r;
        r = stripHtml(r);
        return r.trim();
    }

    function parseRegex(str) {
        try { return window.TavernHelper && window.TavernHelper.builtin ? window.TavernHelper.builtin.parseRegexFromString(str) : null; } catch (e) { return null; }
    }

    function syncRegexes() {
        try {
            var TH = window.TavernHelper;
            if (!TH || !TH.getTavernRegexes) { addLog('warn', '正则同步: TavernHelper 不可用'); return; }
            var gList = TH.getTavernRegexes({ type: 'global' }) || [];
            var cList = [];
            try { cList = TH.getTavernRegexes({ type: 'character' }) || []; } catch (e) {}
            syncedRegexes = gList.concat(cList);
            addLog('info', '正则同步: 获取到 ' + syncedRegexes.length + ' 条正则');
        } catch (e) { addLog('error', '正则同步失败: ' + e.message); }
    }

    function applyRegexes(text) {
        if (!syncedRegexes || !syncedRegexes.length) return text;
        var disabled = settings.regexFilter.disabledIds || [];
        var r = text;
        for (var i = 0; i < syncedRegexes.length; i++) {
            var rx = syncedRegexes[i];
            if (!rx.enabled || !rx.source || !rx.source.ai_output) continue;
            if (!rx.destination || !rx.destination.display) continue;
            if (disabled.indexOf(rx.id) !== -1) continue;
            var re = parseRegex(rx.find_regex);
            if (!re) continue;
            try { r = r.replace(re, rx.replace_string || ''); } catch (e) {}
        }
        return r;
    }

    // ============ 状态 ============
    var lastSentId = null, isResending = false, procIds = {}, player = null, isRangeReading = false;
    var panelOpen = false, currentTab = 'home', roundCount = 0;
    var lastOptions = null, regenMid = null;
    var syncedRegexes = null;

    function resetState() { lastSentId = null; isResending = false; procIds = {}; roundCount = 0; lastOptions = null; regenMid = null; }

    // ============ 自动发送 ============
    async function doAutoSend() {
        if (!settings.running || isResending || !settings.autoSend.enabled) return;
        var maxR = settings.autoSend.maxRounds || 0;
        if (maxR > 0 && roundCount >= maxR) {
            addLog('info', '已达最大轮次(' + maxR + ')，停止自动发送');
            toastr && toastr.success && toastr.success('已达最大轮次(' + maxR + ')，读完最后一条后可在面板点结束', 'TTS自动循环');
            return;
        }
        roundCount++;
        var mode = settings.autoSend.optionMode || 'fixed';
        var text = settings.autoSend.text || '继续';
        if (mode === 'random' && lastOptions && lastOptions.length) {
            text = lastOptions[Math.floor(Math.random() * lastOptions.length)];
            addLog('send', '自动发送[' + roundCount + (maxR > 0 ? '/' + maxR : '') + '] 随机: ' + text);
        } else if (mode === 'pick' && lastOptions && lastOptions.length) {
            var idx = Math.max(0, Math.min((settings.autoSend.optionIndex || 1) - 1, lastOptions.length - 1));
            text = lastOptions[idx];
            addLog('send', '自动发送[' + roundCount + (maxR > 0 ? '/' + maxR : '') + '] 选项#' + (idx + 1) + ': ' + text);
        } else if (mode !== 'fixed' && (!lastOptions || !lastOptions.length)) {
            addLog('warn', '自动发送[' + roundCount + (maxR > 0 ? '/' + maxR : '') + '] 无选项，降级: ' + text);
        } else {
            addLog('send', '自动发送[' + roundCount + (maxR > 0 ? '/' + maxR : '') + ']: ' + text);
        }
        try {
            await window.TavernHelper.triggerSlash('/send ' + text);
            if (!settings.running) return;
            await dly(300);
            if (!settings.running) return;
            await window.TavernHelper.triggerSlash('/trigger');
        } catch (e) {
            addLog('error', '自动发送失败: ' + e.message + '，已停止');
            stopCycle();
        }
    }

    // ============ 文本重发 ============
    async function ensureTags(text) {
        if (!settings.textResend.enabled || !settings.textResend.requiredTags.length) return { ok: true, text: text };
        var tags = settings.textResend.requiredTags, maxR = settings.textResend.maxRetries, delMs = settings.textResend.retryDelay;
        var cur = text;
        for (var at = 0; at <= maxR; at++) {
            var miss = [];
            for (var t = 0; t < tags.length; t++) if (cur.indexOf(tags[t]) === -1) miss.push(tags[t]);
            if (!miss.length) return { ok: true, text: cur };
            if (at >= maxR) {
                addLog('warn', '重发达上限(' + maxR + '次)，跳过标签检查');
                return { ok: true, text: cur };
            }
            addLog('warn', '缺少标签 ' + miss.join(', ') + '，重试(' + (at + 1) + '/' + maxR + ')');
            if (!settings.running) { addLog('warn', '重发被停止中断'); isResending = false; return { ok: false, text: cur }; }
            isResending = true;
            try {
                await window.TavernHelper.triggerSlash('/del 1');
                await dly(delMs);
                await window.TavernHelper.triggerSlash('/trigger');
                var nt = '', nid = null;
                for (var p = 0; p < 60; p++) {
                    if (!settings.running) break;
                    await dly(500);
                    var msgs = window.TavernHelper.getChatMessages('-1');
                    if (msgs) for (var i = 0; i < msgs.length; i++) if (msgs[i].role === 'assistant' && msgs[i].message) { nt = msgs[i].message; nid = msgs[i].message_id; break; }
                    if (nt && nt !== cur) break;
                }
                if (nt) {
                    regenMid = nid;
                    addLog('info', '重试' + (at + 1) + ': 获取到新消息 #' + nid);
                } else {
                    addLog('warn', '重试' + (at + 1) + ': 轮询超时(30s), 使用旧文本');
                }
                cur = nt || cur;
            } catch (e) {
                addLog('error', '重发生成失败: ' + e.message);
                isResending = false;
                return { ok: false, text: cur };
            } finally { isResending = false; }
        }
        return { ok: true, text: cur };
    }

    // ============ 事件处理 ============
    function getLatestAI() {
        try {
            var msgs = window.TavernHelper.getChatMessages('-1');
            if (msgs) for (var i = 0; i < msgs.length; i++) if (msgs[i].role === 'assistant') return msgs[i];
        } catch (e) {}
        return null;
    }

    function getAIOnlyMessages() {
        try {
            var msgs = window.TavernHelper.getChatMessages('0-{{lastMessageId}}');
            if (!msgs) return [];
            var ai = [];
            for (var i = 0; i < msgs.length; i++) if (msgs[i].role === 'assistant') ai.push(msgs[i]);
            return ai;
        } catch (e) { return []; }
    }

    function getAIMessagesByRange(startFloor, endFloor) {
        try {
            var msgs = window.TavernHelper.getChatMessages('0-{{lastMessageId}}');
            if (!msgs) return [];
            var total = msgs.length;
            var start = startFloor > 0 ? startFloor - 1 : total + startFloor;
            var end = endFloor > 0 ? endFloor - 1 : total + endFloor;
            if (start > end) { var tmp = start; start = end; end = tmp; }
            start = Math.max(0, start);
            end = Math.min(total - 1, end);
            var ai = [];
            for (var i = start; i <= end; i++) {
                if (msgs[i].role === 'assistant') ai.push(msgs[i]);
            }
            return ai;
        } catch (e) { return []; }
    }

    function onPlayerStart(item) {
        if (!settings.running || isResending || !settings.autoSend.enabled || !item || !item.id || lastSentId === item.id) return;
        if (settings.autoRead) return;
        lastSentId = item.id;
        addLog('info', '开始播放 #' + (item.id || ''));
        doAutoSend();
    }

    async function processAI(msg) {
        if (!msg || !msg.message || !msg.message.trim()) return;
        var mid = msg.message_id;
        if (isResending) { addLog('info', '正在重发中, 跳过消息 #' + mid); return; }
        if (procIds[mid]) return;
        if (!settings.running && !settings.autoRead) return;
        procIds[mid] = true;

        var raw = msg.message;
        if (settings.autoRead) {
            addLog('info', '自动阅读 #' + mid + ' (' + raw.length + '字)');
            try {
                if (settings.tts.enabled) {
                    var fc = settings.textFilter;
                    var regexOn = settings.regexFilter.enabled;
                    var text = filterText(raw, { readOn: fc.enabled && fc.readEnabled, read: fc.readRanges || [], skipOn: fc.enabled && fc.skipEnabled, skip: fc.skipRanges || [] }, regexOn);
                    if (regexOn) { text = applyRegexes(text); text = stripHtml(text).trim(); }
                    if (text) {
                        if (text.length !== raw.length) addLog('info', '文本过滤 ' + raw.length + '→' + text.length + '字');
                        doTTS(mid, text);
                    } else {
                        addLog('warn', '消息 #' + mid + ' 过滤后为空，跳过TTS');
                    }
                }
            } catch (e) { addLog('error', '自动阅读 #' + mid + ' 失败: ' + e.message); }
            finally { delete procIds[mid]; }
            return;
        }
        var optMatch = raw.match(/<options>(.*?)<\/options>/);
        if (optMatch) {
            lastOptions = optMatch[1].split('|').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
            addLog('info', '收到AI消息 #' + mid + ' (' + raw.length + '字), 检测到' + lastOptions.length + '个选项');
        } else {
            lastOptions = null;
            addLog('info', '收到AI消息 #' + mid + ' (' + raw.length + '字)');
        }

        try {
            var rs = await ensureTags(raw);
            if (!rs.ok || !settings.running) { delete procIds[mid]; return; }

            if (settings.tts.enabled) {
                var fc = settings.textFilter;
                var regexOn = settings.regexFilter.enabled;
                var text = filterText(rs.text, { readOn: fc.enabled && fc.readEnabled, read: fc.readRanges || [], skipOn: fc.enabled && fc.skipEnabled, skip: fc.skipRanges || [] }, regexOn);
                if (regexOn) { text = applyRegexes(text); text = stripHtml(text).trim(); }
                if (text) {
                    if (text.length !== rs.text.length) addLog('info', '文本过滤 ' + rs.text.length + '→' + text.length + '字');
                    doTTS(mid, text);
                } else {
                    addLog('warn', '消息 #' + mid + ' 过滤后为空，跳过TTS');
                }
            }
        } catch (e) { addLog('error', '处理消息 #' + mid + ' 失败: ' + e.message); }
        finally { delete procIds[mid]; }
    }

    var msgDebounce = null;
    function onMsgReceived() {
        if (isRangeReading) return;
        if (!settings.running && !settings.autoRead) return;
        if (msgDebounce) clearTimeout(msgDebounce);
        msgDebounce = setTimeout(function() {
            msgDebounce = null;
            var m = getLatestAI();
            if (m) {
                if (regenMid && m.message_id === regenMid) {
                    addLog('info', '跳过已重发的消息 #' + m.message_id);
                    regenMid = null;
                    return;
                }
                addLog('info', '消息事件触发, 找到AI #' + m.message_id);
                processAI(m);
            } else {
                addLog('info', '消息事件触发, 未找到AI消息');
            }
        }, 300);
    }

    async function doTTS(mid, text) {
        var voice = settings.tts.voice || 'female_1', rate = settings.tts.rate || 0;
        addLog('tts', '合成 #' + mid + ' (' + text.length + '字, ' + voice + ')...');
        var key = cKey(text, voice, rate);
        var ri = rndInfo();
        try {
            var blob = await getCached(key);
            if (blob) {
                updateNowPlaying('<span>📦</span><span> #' + mid + '</span><span>' + ri.round + '</span><span> 从缓存读取...</span>');
                addLog('tts', '✓ #' + mid + ' 命中缓存');
            } else {
                updateNowPlaying('<span>⏳</span><span> #' + mid + '</span><span>' + ri.round + '</span><span> 正在合成...</span>');
                blob = await synTTS(text, voice, rate);
                setCached(key, blob).catch(function() {});
            }
            player.enqueue({ id: 'msg-' + mid, blob: blob, text: text });
            addLog('tts', '✓ #' + mid + ' 合成完成，入队');
        } catch (e) {
            addLog('error', 'TTS失败 #' + mid + ': ' + e.message);
            hideNowPlaying();
        }
    }

    // ============ 测试TTS ============
    async function testTTS() {
        addLog('info', '===== 测试TTS =====');
        var msg = getLatestAI();
        if (!msg) { addLog('warn', '测试: 没有AI消息'); return; }
        var raw = msg.message || '';
        addLog('info', '测试: 获取 #' + msg.message_id + ' (' + raw.length + '字)');
        var fc = settings.textFilter;
        var regexOn = settings.regexFilter.enabled;
        var text = filterText(raw, { readOn: fc.enabled && fc.readEnabled, read: fc.readRanges || [], skipOn: fc.enabled && fc.skipEnabled, skip: fc.skipRanges || [] }, regexOn);
        if (regexOn) { text = applyRegexes(text); text = stripHtml(text).trim(); }
        if (text.length !== raw.length) addLog('info', '测试: 过滤 ' + raw.length + '→' + text.length + '字');
        if (!text) { addLog('warn', '测试: 过滤后为空'); return; }
        var voice = settings.tts.voice || 'female_1', rate = settings.tts.rate || 0;
        addLog('tts', '测试: 合成 (' + voice + ')...');
        try {
            var blob = await synTTS(text, voice, rate);
            player.enqueue({ id: 'test-' + Date.now(), blob: blob, text: text });
            addLog('tts', '✓ 测试: 合成成功，播放');
            toastr && toastr.success && toastr.success('TTS朗读已开始', 'TTS自动循环');
        } catch (e) {
            addLog('error', '测试: TTS失败: ' + e.message);
            toastr && toastr.warning && toastr.warning('TTS失败: ' + e.message, 'TTS自动循环');
        }
    }

    // ============ 范围朗读 ============
    async function readRange(startFloor, endFloor) {
        isRangeReading = true;
        var msgs = getAIMessagesByRange(startFloor, endFloor);
        addLog('info', '===== 范围朗读 ' + startFloor + '→' + endFloor + '楼 =====');
        if (!msgs.length) {
            addLog('warn', '范围朗读: 指定楼层无AI消息');
            toastr && toastr.warning && toastr.warning('指定范围内无AI消息', 'TTS自动循环');
            isRangeReading = false;
            return;
        }
        addLog('info', '范围朗读: 共 ' + msgs.length + ' 条');
        toastr && toastr.info && toastr.info('朗读 ' + msgs.length + ' 条消息...', 'TTS自动循环');
        var fc = settings.textFilter;
        var regexOn = settings.regexFilter.enabled;
        for (var i = 0; i < msgs.length; i++) {
            var msg = msgs[i];
            var raw = msg.message || '';
            if (!raw.trim()) continue;
            var text = filterText(raw, { readOn: fc.enabled && fc.readEnabled, read: fc.readRanges || [], skipOn: fc.enabled && fc.skipEnabled, skip: fc.skipRanges || [] }, regexOn);
            if (regexOn) { text = applyRegexes(text); text = stripHtml(text).trim(); }
            if (!text) continue;
            doTTS('rng-' + msg.message_id, text);
        }
        isRangeReading = false;
        addLog('info', '范围朗读: 全部入队完毕');
    }

    // ============ 启动/停止 ============
    function startCycle() {
        settings.running = true;
        settings.autoRead = false;
        resetState();
        saveSettings();
        addLog('info', '循环已启动');
        refreshPanel();
        if (settings.autoSend.enabled) doAutoSend();
        toastr && toastr.success && toastr.success('TTS自动循环已启动', 'TTS自动循环');
    }

    function stopCycle() {
        settings.running = false;
        resetState();
        if (player) player.clear();
        if (msgDebounce) { clearTimeout(msgDebounce); msgDebounce = null; }
        saveSettings();
        addLog('info', '循环已终止（含TTS）');
        refreshPanel();
        toastr && toastr.info && toastr.info('TTS自动循环已终止', 'TTS自动循环');
    }

    function pauseCycle() {
        settings.running = false;
        lastSentId = null;
        if (msgDebounce) { clearTimeout(msgDebounce); msgDebounce = null; }
        saveSettings();
        addLog('info', '循环已暂停（TTS继续播完）');
        refreshPanel();
        toastr && toastr.info && toastr.info('循环已暂停，TTS继续朗读完毕', 'TTS自动循环');
    }

    function startAutoRead() {
        settings.autoRead = true;
        settings.running = false;
        resetState();
        saveSettings();
        addLog('info', '自动阅读已启动');
        refreshPanel();
        var m = getLatestAI();
        if (m && m.message && m.message.trim()) processAI(m);
        toastr && toastr.success && toastr.success('自动阅读已启动', 'TTS自动循环');
    }

    function stopAutoRead() {
        settings.autoRead = false;
        if (player) player.clear();
        saveSettings();
        addLog('info', '自动阅读已停止');
        refreshPanel();
        toastr && toastr.info && toastr.info('自动阅读已停止', 'TTS自动循环');
    }

    // ============ UI ============
    function PD() { return window.parent.document; }

    function rndInfo() {
        var r = ' #?';
        var maxR = settings.autoSend.maxRounds || 0;
        return { mid: r, round: maxR > 0 ? ' [' + roundCount + '/' + maxR + ']' : ' [' + roundCount + '/∞]' };
    }

    function rndInfoFromItem(item) {
        var mid = '';
        if (item && item.id) { mid = ' #' + String(item.id).replace('msg-', ''); }
        var maxR = settings.autoSend.maxRounds || 0;
        return { mid: mid, round: maxR > 0 ? ' [' + roundCount + '/' + maxR + ']' : ' [' + roundCount + '/∞]' };
    }

    function updateNowPlaying(html) {
        var el = PD().getElementById('ta-now-playing');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ta-now-playing';
            $(PD().body).append(el);
        }
        el.innerHTML = html;
        el.classList.add('visible');
    }

    function showNowPlaying(item) {
        var ri = rndInfoFromItem(item);
        var preview = '';
        if (item && item.text) preview = item.text.replace(/[\r\n]/g, ' ').slice(0, 28);
        updateNowPlaying('<span>🔊</span><span>' + ri.mid + '</span><span>' + ri.round + '</span><span> ' + escH(preview) + (item && item.text && item.text.length > 28 ? '...' : '') + '</span>');
    }

    function hideNowPlaying() {
        var el = PD().getElementById('ta-now-playing');
        if (el) el.classList.remove('visible');
    }

    function injectStyles() {
        if (PD().getElementById(STYLE_ID)) return;
        var style = PD().createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '#ta-panel-overlay{display:none;position:fixed;z-index:99998;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4)}' +
            '#ta-panel-overlay.visible{display:block}' +
            '#ta-panel{position:fixed;z-index:99999;top:50%;left:50%;transform:translate(-50%,-50%);width:500px;max-height:85vh;background:#1e1e2e;border:1px solid #444;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:none;flex-direction:column;overflow:hidden;color:#ddd;font-size:14px}' +
            '#ta-panel.visible{display:flex}' +
            '#ta-panel-header{padding:14px 18px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:16px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}' +
            '#ta-panel-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0 4px}' +
            '.ta-tabs{display:flex;border-bottom:1px solid #444}' +
            '.ta-tab{padding:8px 16px;cursor:pointer;font-size:13px;color:#888;border-bottom:2px solid transparent;transition:.2s;position:relative}' +
            '.ta-tab:hover{color:#ccc}' +
            '.ta-tab.active{color:#667eea;border-bottom-color:#667eea}' +
            '.ta-tab .ta-badge{position:absolute;top:2px;right:2px;background:#e74c3c;color:#fff;font-size:10px;border-radius:8px;padding:0 5px;line-height:16px;min-width:16px;text-align:center}' +
            '#ta-panel-body{padding:16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:14px}' +
            '.ta-section{border:1px solid #444;border-radius:8px;padding:12px}' +
            '.ta-section-title{font-size:14px;font-weight:bold;margin-bottom:10px;color:#667eea;display:flex;align-items:center;gap:8px}' +
            '.ta-toggle{position:relative;display:inline-block;width:40px;height:22px;margin-left:auto}' +
            '.ta-toggle input{opacity:0;width:0;height:0}' +
            '.ta-toggle .ta-toggle-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#555;border-radius:22px;transition:.3s}' +
            '.ta-toggle .ta-toggle-slider::before{content:"";position:absolute;width:16px;height:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}' +
            '.ta-toggle input:checked+.ta-toggle-slider{background:#667eea}' +
            '.ta-toggle input:checked+.ta-toggle-slider::before{transform:translateX(18px)}' +
            '.ta-form-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}' +
            '.ta-form-row label{min-width:50px;font-size:13px;white-space:nowrap}' +
            '.ta-form-row select,.ta-form-row input[type=number],.ta-form-row input[type=text]{flex:1;background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 8px;font-size:13px;box-sizing:border-box}' +
            '.ta-form-row input[type=range]{flex:1}' +
            '.ta-textarea{width:100%;min-height:60px;background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:6px 8px;font-size:13px;resize:vertical;font-family:inherit;box-sizing:border-box}' +
            '.ta-range-row{position:relative;display:flex;flex-direction:column;gap:2px;margin-bottom:8px;padding:8px 10px;background:rgba(255,255,255,.03);border-radius:4px}' +
            '.ta-range-field{display:flex;align-items:center;gap:6px}' +
            '.ta-range-label{min-width:32px;font-size:12px;color:#888;white-space:nowrap}' +
            '.ta-range-arrow{text-align:center;color:#667eea;font-size:13px;line-height:1}' +
            '#ta-panel .ta-range-row input[type=text]{flex:1;min-width:0;background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 6px;font-size:12px;box-sizing:border-box;overflow:hidden}' +
            '.ta-range-row .ta-rm-range{position:absolute;top:6px;right:6px}' +
            '.ta-btn{background:#667eea;color:#fff;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:13px}' +
            '.ta-btn:hover{background:#5a6fd6}' +
            '.ta-btn-sm{padding:2px 8px;font-size:12px}' +
            '.ta-btn-danger{background:#e74c3c}' +
            '.ta-btn-danger:hover{background:#c0392b}.ta-status-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.ta-status-card{padding:8px 12px;border-radius:6px;font-size:13px;text-align:center;transition:background .2s}.ta-status-card.on{background:rgba(78,205,196,.15);border:1px solid rgba(78,205,196,.3);color:#4ecdc4}.ta-status-card.off{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);color:#888}' +
            '.ta-btn-group{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}' +
            '.ta-hint{font-size:11px;color:#888;margin-top:2px}' +
            '.ta-disabled{opacity:.5;pointer-events:none}' +
            '.ta-tag-list{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}' +
            '.ta-tag-item{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:rgba(102,126,234,.2);border-radius:12px;font-size:12px}' +
            '.ta-tag-item .ta-tag-rm{cursor:pointer;color:#e74c3c;font-weight:bold;font-size:14px;line-height:1}' +
            '.ta-tag-input-row{display:flex;gap:6px}' +
            '.ta-tag-input-row input{flex:1;background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 8px;font-size:12px;box-sizing:border-box}' +
            '.ta-rate-val{min-width:36px;text-align:center;font-size:13px}' +
            '.ta-start-btn{flex:1;padding:10px;font-size:15px;font-weight:bold;border-radius:8px;cursor:pointer;border:none}' +
            '.ta-start-btn.start{background:#4ecdc4;color:#1e1e2e}' +
            '.ta-start-btn.start:hover{opacity:.9}' +
            '.ta-start-btn.pause{background:#f0ad4e;color:#1e1e2e}' +
            '.ta-start-btn.pause:hover{opacity:.9}' +
            '.ta-start-btn.abort{background:#f5576c;color:#fff}' +
            '.ta-start-btn.abort:hover{opacity:.9}' +
            '.ta-ctl-row{display:flex;gap:8px;margin-bottom:4px}' +
            '.ta-log-entry{display:flex;gap:8px;padding:3px 0;font-size:12px;font-family:monospace;border-bottom:1px solid rgba(255,255,255,.03)}' +
            '.ta-log-time{color:#888;white-space:nowrap;min-width:70px}' +
            '.ta-log-icon{width:18px;text-align:center}' +
            '.ta-log-msg{word-break:break-all;flex:1}' +
            '.ta-log-send{color:#4ecdc4}.ta-log-tts{color:#667eea}.ta-log-info{color:#888}.ta-log-warn{color:#f0ad4e}.ta-log-error{color:#e74c3c}' +
            '#ta-now-playing{position:fixed;right:20px;bottom:20px;z-index:99997;background:rgba(30,30,46,.92);border:1px solid #667eea;border-radius:8px;padding:8px 14px;color:#ddd;font-size:13px;display:flex;align-items:center;gap:8px;opacity:0;transform:translateY(10px);transition:opacity .3s,transform .3s;pointer-events:none;max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '#ta-now-playing.visible{opacity:1;transform:translateY(0)}' +
            '@media(max-width:540px){#ta-panel{width:96vw;max-width:500px;max-height:92vh}#ta-panel-body{padding:10px;font-size:13px}.ta-section{padding:10px}.ta-range-row{padding:6px 8px}.ta-range-row input[type=text]{min-width:60px}.ta-start-btn{font-size:13px;padding:8px}#ta-now-playing{right:8px;bottom:8px;max-width:80vw;font-size:12px;padding:6px 10px}}';
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
        h.id = 'ta-panel-header';
        h.innerHTML = '<span>🎛 TTS自动循环</span>';
        var cb = document.createElement('button');
        cb.id = 'ta-panel-close';
        cb.textContent = '✕';
        cb.addEventListener('click', closePanel);
        h.appendChild(cb);
        var b = document.createElement('div');
        b.id = 'ta-panel-body';
        p.appendChild(h); p.appendChild(b);
        $(PD().body).append(p);
        makePanelDraggable(p, h);
    }

    function makePanelDraggable(panel, handle) {
        var ox = 0, oy = 0, dg = false;
        $(handle).on('mousedown', function(e) {
            if (e.target === PD().getElementById('ta-panel-close')) return;
            dg = true; var r = panel.getBoundingClientRect();
            ox = e.clientX - r.left; oy = e.clientY - r.top;
            $(panel).css('transform', 'none');
        });
        $(PD()).on('mousemove.tap', function(e) {
            if (!dg) return;
            var pw = panel.offsetWidth, ph = panel.offsetHeight;
            var maxX = Math.max(0, window.parent.innerWidth - 40);
            var maxY = Math.max(0, window.parent.innerHeight - 20);
            var l = Math.max(20 - pw, Math.min(maxX, e.clientX - ox));
            var t = Math.max(-20, Math.min(maxY, e.clientY - oy));
            $(panel).css({ left: l + 'px', top: t + 'px' });
        });
        $(PD()).on('mouseup.tap', function() { dg = false; });
    }

    function openPanel() {
        panelOpen = true;
        createOverlay();
        createPanel();
        var p = $(PD().getElementById(PANEL_ID));
        if (p.length) p.css({ left: '', top: '', transform: '' });
        $(PD().getElementById(PANEL_OVERLAY_ID)).addClass('visible');
        $(PD().getElementById(PANEL_ID)).addClass('visible');
        currentTab = 'home';
        refreshPanel();
    }

    function closePanel() {
        panelOpen = false;
        $(PD().getElementById(PANEL_OVERLAY_ID)).removeClass('visible');
        $(PD().getElementById(PANEL_ID)).removeClass('visible');
    }

    function escH(s) { return $('<div>').text(s || '').html(); }
    function rRanges(ranges, type) {
        if (!ranges.length) return '<div class="ta-hint">无</div>';
        return ranges.map(function(r, i) {
            return '<div class="ta-range-row" data-idx="' + i + '" data-type="' + type + '">' +
                '<button class="ta-btn ta-btn-sm ta-btn-danger ta-rm-range">✕</button>' +
                '<div class="ta-range-field"><span class="ta-range-label">起始</span><input class="ta-range-start" type="text" value="' + escH(r.start || '') + '" placeholder="起始"></div>' +
                '<div class="ta-range-arrow">↓</div>' +
                '<div class="ta-range-field"><span class="ta-range-label">结束</span><input class="ta-range-end" type="text" value="' + escH(r.end || '') + '" placeholder="结束"></div></div>';
        }).join('');
    }
    function rTags(tags) {
        if (!tags.length) return '<span class="ta-hint">无标签</span>';
        return tags.map(function(t, i) { return '<span class="ta-tag-item" data-idx="' + i + '">' + escH(t) + '<span class="ta-tag-rm" data-idx="' + i + '">✕</span></span>'; }).join('');
    }

    function badLogCount() {
        var c = 0;
        for (var i = 0; i < logBuf.length; i++) { if (logBuf[i].l === 'warn' || logBuf[i].l === 'error') c++; }
        return c;
    }

    function iconFor(l) {
        if (l === 'send') return '📤';
        if (l === 'tts') return '🔊';
        if (l === 'warn') return '⚠️';
        if (l === 'error') return '❌';
        return 'ℹ️';
    }


    function stCard(label, icon, on) {
        return '<div class="ta-status-card' + (on ? ' on' : '') + '">' + icon + ' ' + label + '</div>';
    }

    function renderHomeTab(s) {
        var html = '';
        html += '<div class="ta-section"><div class="ta-section-title"><span>🔄 循环模式</span></div>';
        html += '<div style="text-align:center;margin-bottom:4px;">' +
            (s.running
                ? '<div class="ta-ctl-row"><button class="ta-start-btn pause ta-pause-btn">⏸ 暂 停</button><button class="ta-start-btn abort ta-abort-btn">■ 终 止</button></div>'
                : '<button class="ta-start-btn start ta-ctl-btn">▶ 开 始</button>') +
            '<div style="margin-top:6px;font-size:13px;">' + (s.running ? '<span style="color:#4ecdc4;">● 运行中</span>' : '<span style="color:#888;">○ 已停止</span>') + '</div>';
        html += '<div class="ta-hint">TTS朗读 + 自动发送循环</div></div></div>';

        html += '<div class="ta-section"><div class="ta-section-title"><span>👁 纯阅读模式</span></div>';
        html += '<div style="display:flex;align-items:center;gap:10px;">' +
            '<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">' +
            '<input class="ta-ar-toggle" type="checkbox"' + (s.autoRead ? ' checked' : '') + '> 自动阅读</label>' +
            (s.autoRead ? '<span style="color:#4ecdc4;font-size:13px;">● 已启动</span>' : '<span style="color:#888;font-size:13px;">○ 已停止</span>') +
            '</div>';
        html += '<div class="ta-hint">不发送消息，仅朗读新回复</div></div>';

        html += '<div class="ta-status-grid">' +
            stCard('自动发送', '📤', s.autoSend.enabled) +
            stCard('TTS朗读', '🔊', s.tts.enabled) +
            stCard('文本过滤', '✂', s.textFilter.enabled) +
            stCard('文本重发', '🔄', s.textResend.enabled) +
            stCard('正则过滤', '🔧', s.regexFilter.enabled) +
            '</div>';

        html += '<div class="ta-section"><div class="ta-section-title"><span>📖 范围朗读</span></div>' +
            '<div><div class="ta-form-row" style="flex-wrap:wrap;gap:6px;">' +
            '<label style="min-width:auto;">起始楼层</label><input class="ta-rng-start" type="number" value="1" min="-999" max="999" style="width:52px;">' +
            '<label style="min-width:auto;">结束楼层</label><input class="ta-rng-end" type="number" value="-1" min="-999" max="999" style="width:52px;">' +
            '<button class="ta-btn ta-btn-sm ta-rng-read" style="margin-left:4px;">▶ 朗读</button>' +
            '<span class="ta-hint ta-rng-count" style="margin-left:8px;"></span>' +
            '</div><div class="ta-hint" style="margin-top:4px;">负数=倒数（-1=最新），正数=与酒馆楼层号一致</div></div></div>';

        html += '<div class="ta-btn-group"><button class="ta-btn ta-test-tts-btn" style="margin-right:auto;">🔊 测试TTS</button>' +
            '<button class="ta-btn ta-save-btn">💾 保存设置</button>' +
            '<button class="ta-btn ta-reset-btn">🔄 重置默认</button></div>';
        return html;
    }

    function renderSendTab(s) {
        var html = '<div class="ta-section"><div class="ta-section-title"><span>\uD83D\uDCE4 自动发送</span><label class="ta-toggle"><input class="ta-as-toggle" type="checkbox"' + (s.autoSend.enabled ? ' checked' : '') + '><span class="ta-toggle-slider"></span></label></div>';
        html += '<div class="' + (s.autoSend.enabled ? '' : 'ta-disabled') + '">';
        html += '<div class="ta-form-row"><label>发送文本</label><input class="ta-as-text" type="text" value="' + escH(s.autoSend.text || '继续') + '" placeholder="要发送的文本"></div>';
        html += '<div class="ta-form-row"><label>发送模式</label><select class="ta-as-mode"><option value="fixed"' + ((s.autoSend.optionMode || 'fixed') === 'fixed' ? ' selected' : '') + '>固定文本</option><option value="random"' + (s.autoSend.optionMode === 'random' ? ' selected' : '') + '>随机选项</option><option value="pick"' + (s.autoSend.optionMode === 'pick' ? ' selected' : '') + '>指定选项</option></select></div>';
        html += '<div class="ta-form-row ta-as-optidx-row" style="margin-top:6px;display:' + (s.autoSend.optionMode === 'pick' ? '' : 'none') + ';"><label>选项序号</label><input class="ta-as-optidx" type="number" min="1" max="99" value="' + (s.autoSend.optionIndex || 1) + '"></div>';
        html += '<div class="ta-form-row" style="margin-top:6px;"><label>最大轮次</label><input class="ta-max-rounds" type="number" min="0" max="999" value="' + (s.autoSend.maxRounds || 0) + '"><div class="ta-hint" style="margin:0;">0=无限</div></div>';
        html += '</div></div>';
        return html;
    }

    function renderTTSTab(s) {
        var vopts = EDGE_VOICES.map(function(v) { return '<option value="' + escH(v.key) + '"' + (s.tts.voice === v.key ? ' selected' : '') + '>' + escH(v.name) + ' (' + escH(v.tag) + ')</option>'; }).join('');
        var html = '<div class="ta-section"><div class="ta-section-title"><span>\uD83D\uDD0A TTS朗读</span><label class="ta-toggle"><input class="ta-tts-toggle" type="checkbox"' + (s.tts.enabled ? ' checked' : '') + '><span class="ta-toggle-slider"></span></label></div>';
        html += '<div class="' + (s.tts.enabled ? '' : 'ta-disabled') + '">';
        html += '<div class="ta-form-row"><label>音色</label><select class="ta-tts-voice">' + vopts + '</select></div>';
        html += '<div class="ta-form-row"><label>语速</label><input class="ta-tts-rate" type="range" min="-50" max="100" value="' + (s.tts.rate || 0) + '"><span class="ta-rate-val">' + (s.tts.rate || 0) + '%</span></div>';
        html += '</div></div>';
        html += '<div style="text-align:center;margin-top:8px;"><button class="ta-btn ta-test-tts-btn">\uD83D\uDD0A 测试TTS</button></div>';
        return html;
    }

    function renderFilterTab(s) {
        var html = '<div class="ta-section"><div class="ta-section-title"><span>\u2702 文本过滤</span><label class="ta-toggle"><input class="ta-f-toggle" type="checkbox"' + (s.textFilter.enabled ? ' checked' : '') + '><span class="ta-toggle-slider"></span></label></div>';
        html += '<div class="' + (s.textFilter.enabled ? '' : 'ta-disabled') + '">';
        html += '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:4px;"><input class="ta-read-on" type="checkbox"' + (s.textFilter.readEnabled ? ' checked' : '') + '><b>只读区间</b><span class="ta-hint">(跳过之后执行)</span></label>';
        html += '<div class="ta-hint">起始留空=从头读，结束留空=读到末尾</div><div class="ta-read-ranges">' + rRanges(s.textFilter.readRanges || [], 'read') + '</div>';
        html += '<button class="ta-btn ta-btn-sm ta-add-read">＋ 添加只读区间</button>';
        html += '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;margin-bottom:4px;"><input class="ta-skip-on" type="checkbox"' + (s.textFilter.skipEnabled ? ' checked' : '') + '><b>跳过区间</b><span class="ta-hint">(先于只读执行)</span></label>';
        html += '<div class="ta-hint">起始留空=从头跳，结束留空=跳到末尾</div><div class="ta-skip-ranges">' + rRanges(s.textFilter.skipRanges || [], 'skip') + '</div>';
        html += '<button class="ta-btn ta-btn-sm ta-add-skip">＋ 添加跳过区间</button>';
        html += '</div></div>';
        return html;
    }

    function renderResendTab(s) {
        var html = '<div class="ta-section"><div class="ta-section-title"><span>\uD83D\uDD04 文本重发</span><label class="ta-toggle"><input class="ta-rs-toggle" type="checkbox"' + (s.textResend.enabled ? ' checked' : '') + '><span class="ta-toggle-slider"></span></label></div>';
        html += '<div class="' + (s.textResend.enabled ? '' : 'ta-disabled') + '">';
        html += '<div class="ta-tag-list ta-rs-tags">' + rTags(s.textResend.requiredTags || []) + '</div>';
        html += '<div class="ta-tag-input-row"><input class="ta-rs-tag-input" type="text" placeholder="输入标签（如 &lt;thinking&gt;）"><button class="ta-btn ta-btn-sm ta-add-tag">添加</button></div>';
        html += '<div class="ta-form-row" style="margin-top:8px;"><label>最大重试</label><input class="ta-rs-retries" type="number" min="1" max="50" value="' + (s.textResend.maxRetries || 3) + '"></div>';
        html += '<div class="ta-form-row"><label>间隔(ms)</label><input class="ta-rs-delay" type="number" min="0" max="30000" step="100" value="' + (s.textResend.retryDelay || 500) + '"></div>';
        html += '</div></div>';
        return html;
    }

    function renderLogTab() {
        var bc = badLogCount();
        var html = '<div class="ta-btn-group" style="margin-bottom:8px;">' +
            '<button class="ta-btn ta-btn-sm ta-log-copy">📋 复制全部</button>' +
            '<button class="ta-btn ta-btn-sm ta-btn-danger ta-log-clear">🗑 清空日志</button>' +
            '<span style="color:#888;font-size:12px;margin-left:auto;">共 ' + logBuf.length + ' 条' + (bc > 0 ? '，' + bc + ' 条异常' : '') + '</span></div>';
        if (!logBuf.length) { html += '<div class="ta-hint">暂无日志</div>'; return html; }
        for (var i = logBuf.length - 1; i >= 0; i--) {
            var e = logBuf[i];
            html += '<div class="ta-log-entry">' +
                '<span class="ta-log-time">' + escH(e.t) + '</span>' +
                '<span class="ta-log-icon">' + iconFor(e.l) + '</span>' +
                '<span class="ta-log-msg ta-log-' + e.l + '">' + escH(e.m) + '</span></div>';
        }
        return html;
    }

    function renderRegexTab(s) {
        var rx = syncedRegexes || [];
        var disabled = s.regexFilter.disabledIds || [];
        var aiRegexes = rx.filter(function(r) { return r.source && r.source.ai_output && r.destination && r.destination.display; });
        var html = '<div class="ta-section"><div class="ta-section-title"><span>🔧 正则过滤</span><label class="ta-toggle"><input class="ta-rx-toggle" type="checkbox"' + (s.regexFilter.enabled ? ' checked' : '') + '><span class="ta-toggle-slider"></span></label></div>';
        html += '<div class="' + (s.regexFilter.enabled ? '' : 'ta-disabled') + '">';
        if (s.regexFilter.enabled && !aiRegexes.length) {
            html += '<div style="color:#f0ad4e;font-size:12px;margin-bottom:8px;padding:6px 10px;background:rgba(240,173,78,.1);border:1px solid rgba(240,173,78,.3);border-radius:4px;">⚠ 正则过滤已开启，但尚未同步正则列表，点击下方按钮同步</div>';
        }
        html += '<div style="margin-bottom:8px;"><button class="ta-btn ta-btn-sm ta-rx-sync">🔄 同步正则</button> <span class="ta-hint" style="margin-left:4px;">从SillyTavern同步AI输出相关的正则脚本</span></div>';
        if (!aiRegexes.length) {
            html += '<div class="ta-hint">' + (rx.length ? '没有匹配「AI输出→显示」条件的正则' : '尚未同步，点击上方按钮同步') + '</div>';
        } else {
            for (var i = 0; i < aiRegexes.length; i++) {
                var r = aiRegexes[i];
                var isDisabled = disabled.indexOf(r.id) !== -1;
                var name = escH(r.script_name || '未命名');
                var findStr = escH(r.find_regex || '').slice(0, 60);
                html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;background:rgba(255,255,255,0.03);border-radius:4px;">';
                html += '<input class="ta-rx-item" type="checkbox" data-id="' + escH(r.id) + '"' + (!isDisabled ? ' checked' : '') + '>';
                html += '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:bold;">' + name + '</div>';
                html += '<div class="ta-hint" style="margin:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">/' + findStr + '/</div></div></div>';
            }
        }
        html += '</div></div>';
        return html;
    }


    function refreshPanel() {
        if (!panelOpen) return;
        var panel = PD().getElementById(PANEL_ID);
        if (!panel) return;
        var body = panel.querySelector('#ta-panel-body');
        if (!body) return;
        var s = settings;
        var bc = badLogCount();

        var tabs = '<div class="ta-tabs">' +
            '<div class="ta-tab' + (currentTab === 'home' ? ' active' : '') + ' ta-tab-home">首页</div>' +
            '<div class="ta-tab' + (currentTab === 'send' ? ' active' : '') + ' ta-tab-send">发送</div>' +
            '<div class="ta-tab' + (currentTab === 'tts' ? ' active' : '') + ' ta-tab-tts">TTS</div>' +
            '<div class="ta-tab' + (currentTab === 'filter' ? ' active' : '') + ' ta-tab-filter">过滤</div>' +
            '<div class="ta-tab' + (currentTab === 'resend' ? ' active' : '') + ' ta-tab-resend">重发</div>' +
            '<div class="ta-tab' + (currentTab === 'regex' ? ' active' : '') + ' ta-tab-regex">正则</div>' +
            '<div class="ta-tab' + (currentTab === 'log' ? ' active' : '') + ' ta-tab-log">日志' + (bc > 0 ? '<span class="ta-badge">' + bc + '</span>' : '') + '</div></div>';

        var content;
        switch (currentTab) {
            case 'home':   content = renderHomeTab(s); break;
            case 'send':   content = renderSendTab(s); break;
            case 'tts':    content = renderTTSTab(s); break;
            case 'filter': content = renderFilterTab(s); break;
            case 'resend': content = renderResendTab(s); break;
            case 'regex':  content = renderRegexTab(s); break;
            default:       content = renderLogTab();
        }
        $(body).html(tabs + '<div class="ta-tab-content">' + content + '</div>');
        bindPanel();
    }

    function bindPanel() {
        var panel = PD().getElementById(PANEL_ID);
        if (!panel) return;
        var body = $(panel).find('#ta-panel-body');

        // Tab switching
        body.find('.ta-tab-home').click(function() { currentTab = 'home'; refreshPanel(); });
        body.find('.ta-tab-send').click(function() { currentTab = 'send'; refreshPanel(); });
        body.find('.ta-tab-tts').click(function() { currentTab = 'tts'; refreshPanel(); });
        body.find('.ta-tab-filter').click(function() { currentTab = 'filter'; refreshPanel(); });
        body.find('.ta-tab-resend').click(function() { currentTab = 'resend'; refreshPanel(); });
        body.find('.ta-tab-regex').click(function() { currentTab = 'regex'; refreshPanel(); });
        body.find('.ta-tab-log').click(function() { currentTab = 'log'; refreshPanel(); });

        // Global (all tabs)
        body.find('.ta-log-copy').click(function() {
            var text = logBuf.map(function(e) { return '[' + e.t + '] [' + e.l + '] ' + e.m; }).join('\n');
            window.parent.navigator.clipboard.writeText(text).then(function() { toastr && toastr.success && toastr.success('已复制到剪贴板', 'TTS自动循环'); });
        });
        body.find('.ta-log-clear').click(function() { logBuf = []; refreshPanel(); });

        // Home: save/reset
        body.find('.ta-save-btn').click(function() { saveSettings(); closePanel(); toastr && toastr.success && toastr.success('设置已保存', 'TTS自动循环'); });
        body.find('.ta-reset-btn').click(function() { settings = $.extend(true, {}, DEFAULTS); saveSettings(); refreshPanel(); toastr && toastr.info && toastr.info('已重置为默认设置', 'TTS自动循环'); });

        // Home: start/pause/abort + autoRead + range reading + testTTS
        body.find('.ta-ctl-btn').click(function() { startCycle(); });
        body.find('.ta-pause-btn').click(function() { pauseCycle(); });
        body.find('.ta-abort-btn').click(function() { stopCycle(); });
        body.find('.ta-ar-toggle').change(function() {
            if (this.checked) {
                if (settings.running) { this.checked = false; toastr && toastr.warning && toastr.warning('请先停止循环', 'TTS自动循环'); return; }
                startAutoRead();
            } else {
                stopAutoRead();
            }
        });
        body.find('.ta-rng-read').click(function() {
            var s = parseInt(body.find('.ta-rng-start').val(), 10) || 1;
            var e = parseInt(body.find('.ta-rng-end').val(), 10) || -1;
            readRange(s, e);
        });
        body.find('.ta-rng-start, .ta-rng-end').on('input', function() {
            var s = parseInt(body.find('.ta-rng-start').val(), 10) || 1;
            var e = parseInt(body.find('.ta-rng-end').val(), 10) || -1;
            var msgs = getAIMessagesByRange(s, e);
            body.find('.ta-rng-count').text('共 ' + msgs.length + ' 条AI消息');
        });
        body.find('.ta-test-tts-btn').click(function() { testTTS(); });

        // Send tab
        body.find('.ta-as-toggle').change(function() { settings.autoSend.enabled = this.checked; saveSettings(); refreshPanel(); });
        body.find('.ta-as-text').on('input', function() { settings.autoSend.text = this.value.trim() || '继续'; saveSettings(); });
        body.find('.ta-as-mode').change(function() { settings.autoSend.optionMode = this.value; saveSettings(); refreshPanel(); });
        body.find('.ta-as-optidx').on('input', function() { settings.autoSend.optionIndex = Math.max(1, parseInt(this.value, 10) || 1); saveSettings(); });
        body.find('.ta-max-rounds').on('input', function() { settings.autoSend.maxRounds = Math.max(0, parseInt(this.value, 10) || 0); saveSettings(); });

        // TTS tab
        body.find('.ta-tts-toggle').change(function() { settings.tts.enabled = this.checked; saveSettings(); refreshPanel(); });
        body.find('.ta-tts-voice').change(function() { settings.tts.voice = this.value; saveSettings(); });
        body.find('.ta-tts-rate').on('input', function() { settings.tts.rate = parseInt(this.value, 10); body.find('.ta-rate-val').text(this.value + '%'); saveSettings(); });

        // Filter tab
        body.find('.ta-f-toggle').change(function() { settings.textFilter.enabled = this.checked; saveSettings(); refreshPanel(); });
        body.find('.ta-read-on').change(function() { settings.textFilter.readEnabled = this.checked; saveSettings(); });
        body.find('.ta-skip-on').change(function() { settings.textFilter.skipEnabled = this.checked; saveSettings(); });
        body.find('.ta-add-read').click(function() { if (!Array.isArray(settings.textFilter.readRanges)) settings.textFilter.readRanges = []; settings.textFilter.readRanges.push({ start: '', end: '' }); saveSettings(); refreshPanel(); });
        body.find('.ta-add-skip').click(function() { if (!Array.isArray(settings.textFilter.skipRanges)) settings.textFilter.skipRanges = []; settings.textFilter.skipRanges.push({ start: '', end: '' }); saveSettings(); refreshPanel(); });
        body.on('click', '.ta-rm-range', function() { var row = $(this).closest('.ta-range-row'); var idx = parseInt(row.attr('data-idx'), 10); var t = row.attr('data-type'); var arr = t === 'read' ? settings.textFilter.readRanges : settings.textFilter.skipRanges; if (arr) arr.splice(idx, 1); saveSettings(); refreshPanel(); });
        body.on('input', '.ta-range-start, .ta-range-end', function() { var row = $(this).closest('.ta-range-row'); var idx = parseInt(row.attr('data-idx'), 10); var t = row.attr('data-type'); var arr = t === 'read' ? settings.textFilter.readRanges : settings.textFilter.skipRanges; if (arr && arr[idx]) { arr[idx].start = row.find('.ta-range-start').val() || ''; arr[idx].end = row.find('.ta-range-end').val() || ''; saveSettings(); } });

        // Resend tab
        body.find('.ta-rs-toggle').change(function() { settings.textResend.enabled = this.checked; saveSettings(); refreshPanel(); });
        body.find('.ta-add-tag').click(function() { var v = body.find('.ta-rs-tag-input').val().trim(); if (!v) return; if (!Array.isArray(settings.textResend.requiredTags)) settings.textResend.requiredTags = []; if (!settings.textResend.requiredTags.includes(v)) { settings.textResend.requiredTags.push(v); saveSettings(); refreshPanel(); } body.find('.ta-rs-tag-input').val(''); });
        body.on('click', '.ta-tag-rm', function() { var idx = parseInt($(this).attr('data-idx'), 10); if (!isNaN(idx) && Array.isArray(settings.textResend.requiredTags)) { settings.textResend.requiredTags.splice(idx, 1); saveSettings(); refreshPanel(); } });
        body.find('.ta-rs-retries').on('input', function() { settings.textResend.maxRetries = Math.max(1, parseInt(this.value, 10) || 3); saveSettings(); });
        body.find('.ta-rs-delay').on('input', function() { settings.textResend.retryDelay = Math.max(0, parseInt(this.value, 10) || 500); saveSettings(); });

        // Regex tab
        body.find('.ta-rx-toggle').change(function() { settings.regexFilter.enabled = this.checked; saveSettings(); refreshPanel(); });
        body.find('.ta-rx-sync').click(function() { syncRegexes(); refreshPanel(); });
        body.on('change', '.ta-rx-item', function() {
            var id = $(this).attr('data-id');
            var arr = settings.regexFilter.disabledIds || [];
            if (this.checked) { arr = arr.filter(function(x) { return x !== id; }); }
            else { if (arr.indexOf(id) === -1) arr.push(id); }
            settings.regexFilter.disabledIds = arr;
            saveSettings();
        });
    }
    // ============ 键盘 ============
    $(PD()).on('keydown.ta', function(e) { if (e.key === 'Escape' && panelOpen) closePanel(); });

    // ============ 工具 ============
    function dly(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

    // ============ 初始化 ============
    function initOnce() {
        loadSettings();
        settings.running = false;
        saveSettings();
        injectStyles();
        createOverlay();
        createPanel();
        player = new AudioQ(onPlayerStart);
        window.eventOn(window.tavern_events.MESSAGE_RECEIVED, onMsgReceived);
        syncRegexes();
        addLog('info', '初始化完毕');
    }

    function register() {
        if (typeof getButtonEvent !== 'function') { setTimeout(register, 1000); return; }
        if (window._ta_registered) return;
        window._ta_registered = true;
        initOnce();
        eventOn(getButtonEvent(BTN_NAME), function() { if (!panelOpen) openPanel(); });
        eventOn(getButtonEvent(BTN_READ), function() {
            if (settings.autoRead) { stopAutoRead(); }
            else if (settings.running) { toastr && toastr.warning && toastr.warning('请先停止循环', 'TTS自动循环'); }
            else { startAutoRead(); }
        });
    }

    register();
})();

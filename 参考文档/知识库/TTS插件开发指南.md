# TTS语音插件开发指南

基于 LittleWhiteBox 插件的学习总结

## 一、LittleWhiteBox TTS 插件架构

### 1.1 文件结构
```
modules/tts/
├── tts.js              # 主逻辑(1543行) - 事件监听、消息处理、状态管理
├── tts-api.js          # API封装 - 火山引擎TTS接口调用
├── tts-player.js       # 播放器 - 队列播放管理
├── tts-text.js         # 文本处理 - 提取/分割TTS文本
├── tts-voices.js       # 音色管理 - 音色列表和选择逻辑
├── tts-cache.js        # 缓存 - IndexedDB存储
├── tts-panel.js        # UI面板 - 设置界面
├── tts-auth-provider.js # 鉴权模式音色提供者
├── tts-free-provider.js # 免费音色提供者
└── tts-overlay.html    # 面板HTML
```

### 1.2 核心常量与配置
```javascript
// tts.js 核心常量
const MODULE_ID = 'tts';
const OVERLAY_ID = 'xiaobaix-tts-overlay';
const HTML_PATH = `${extensionFolderPath}/modules/tts/tts-overlay.html`;
const TTS_DIRECTIVE_REGEX = /\[tts:([^\]]*)\]/gi;

// 免费音色键值
const FREE_VOICE_KEYS = new Set([
    'female_1', 'female_2', 'female_3', 'female_4',
    'hk_female_1', 'hk_female_2', 'hk_male_1',
    'tw_female_1', 'tw_female_2', 'tw_male_1',
    'male_1', 'male_2', 'male_3', 'male_4',
    'en_female_1', 'en_female_2', 'en_female_3', 'en_male_1', 'en_male_2',
    'ja_female_1', 'ja_male_1',
]);
```

---

## 二、触发机制

### 2.1 事件监听（tts.js:1350）
```javascript
import { event_types } from "../../../../../../script.js";
import { createModuleEvents } from "../../core/event-manager.js";

const events = createModuleEvents(MODULE_ID);

// 监听消息渲染完成事件
events.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);

// 其他相关事件
events.on(event_types.CHAT_CHANGED, onChatChanged);
events.on(event_types.MESSAGE_EDITED, handleDirectiveEnhance);
events.on(event_types.MESSAGE_UPDATED, handleDirectiveEnhance);
events.on(event_types.MESSAGE_SWIPED, handleDirectiveEnhance);
events.on(event_types.GENERATION_STOPPED, onGenerationEnd);
events.on(event_types.GENERATION_ENDED, (data) => {
    notifyTtsAfterAi(data, 'generation_ended');
    onGenerationEnd();
});
```

### 2.2 消息渲染回调（tts.js:917-928）
```javascript
function onCharacterMessageRendered(data) {
    if (!isModuleEnabled()) return;

    try {
        const context = getContext();
        const chat = context.chat;
        const messageId = data.messageId ?? (chat.length - 1);
        if (!Number.isFinite(messageId)) return;
        
        if (!prepareCharacterMessageUi(messageId)) return;
        notifyTtsAfterAi(data, 'character_message_rendered');
    } catch {}
}
```

---

## 三、TTS合成流程

### 3.1 主流程（tts.js:593-742）
```javascript
async function speakMessage(messageId, { mode = 'manual' } = {}) {
    if (!isModuleEnabled()) return;
    
    // 1. 获取消息数据
    const message = getMessageData(messageId);
    if (!message || message.is_user) return;
    
    const messageEl = getMessageElement(messageId);
    if (!messageEl) return;
    
    // 2. 创建UI面板
    ensureTtsPanel(messageEl, messageId, handleMessagePlayClick);
    
    // 3. 提取TTS文本（过滤标签、指令）
    const speakText = getSpeakTextFromMessage(message);
    if (!speakText.trim()) {
        const state = ensureMessageState(messageId);
        state.status = 'idle';
        updateTtsPanel(messageId, state);
        return;
    }
    
    // 4. 解析音色段落（支持[tts:speaker]指令）
    let segments = parseTtsSegments(speakText);
    if (!segments.length) {
        // 无段落处理...
        return;
    }
    
    // 5. 解析音色来源（免费/鉴权）
    const mySpeakers = config.volc?.mySpeakers || [];
    const defaultSpeaker = config.volc.defaultSpeaker || FREE_DEFAULT_VOICE;
    const defaultResolved = resolveSpeakerWithSource('', mySpeakers, defaultSpeaker);
    
    const resolvedSegments = segments.map(seg => {
        const resolved = seg.speaker 
            ? resolveSpeakerWithSource(seg.speaker, mySpeakers, defaultSpeaker)
            : defaultResolved;
        return { 
            ...seg, 
            resolvedSpeaker: resolved.value, 
            resolvedSource: resolved.source,
            resolvedResourceId: resolved.resourceId
        };
    });
    
    // 6. 检查是否需要鉴权
    const needsAuth = resolvedSegments.some(s => s.resolvedSource === 'auth');
    if (needsAuth && !isAuthConfigured()) {
        toastr?.warning?.('部分音色需要配置鉴权 API，将仅播放免费音色');
        // 过滤出免费音色...
    }
    
    // 7. 根据音色类型调用不同的合成方法
    const batchId = generateBatchId();
    const hasFree = resolvedSegments.some(s => s.resolvedSource === 'free');
    const hasAuth = resolvedSegments.some(s => s.resolvedSource === 'auth');
    const isMixed = hasFree && hasAuth;
    
    if (isMixed) {
        // 混合模式：遍历所有段落，分别调用免费/鉴权API
        const expandedSegments = expandMixedSegments(resolvedSegments);
        for (let i = 0; i < expandedSegments.length; i++) {
            const seg = expandedSegments[i];
            if (seg.resolvedSource === 'free') {
                await speakSingleFreeSegment(messageId, seg, i, batchId);
            } else {
                await speakSegmentAuth(messageId, seg, i, batchId, ctx);
            }
        }
    } else if (hasFree) {
        await speakMessageFree({...});
    } else if (hasAuth) {
        await speakMessageAuth({...});
    }
}
```

### 3.2 文本提取（tts-text.js:9-19）
```javascript
export function extractSpeakText(rawText, rules = {}) {
    if (!rawText || typeof rawText !== 'string') return '';
    
    let text = rawText;
    
    // 保留[tts:...]标签的占位符
    const ttsPlaceholders = [];
    text = text.replace(/\[tts:[^\]]*\]/gi, (match) => {
        const placeholder = `__TTS_TAG_${ttsPlaceholders.length}__`;
        ttsPlaceholders.push(match);
        return placeholder;
    });
    
    // 应用跳过范围规则
    const ranges = Array.isArray(rules.skipRanges) ? rules.skipRanges : [];
    for (const range of ranges) {
        const start = String(range?.start ?? '').trim();
        const end = String(range?.end ?? '').trim();
        // ... 处理跳过范围
    }
    
    // 应用读取范围规则
    const readRanges = Array.isArray(rules.readRanges) ? rules.readRanges : [];
    if (rules.readRangesEnabled && readRanges.length) {
        // ... 处理读取范围
    }
    
    // 恢复[tts:...]标签
    for (let i = 0; i < ttsPlaceholders.length; i++) {
        text = text.replace(`__TTS_TAG_${i}__`, ttsPlaceholders[i]);
    }
    
    return text;
}
```

### 3.3 解析TTS段落（tts-text.js）
```javascript
export function parseTtsSegments(text) {
    const segments = [];
    const regex = /\[tts:([^\]]*)\]/gi;
    let lastIndex = 0;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
        // 添加标签前的文本（使用默认音色）
        if (match.index > lastIndex) {
            segments.push({
                text: text.slice(lastIndex, match.index),
                speaker: '',
                emotion: '',
                context: ''
            });
        }
        
        // 解析[tts:speaker|emotion=xxx|context=xxx]参数
        const params = match[1];
        const seg = { text: '', speaker: '', emotion: '', context: '' };
        
        // 解析参数...
        if (params.includes('|')) {
            const parts = params.split('|');
            seg.speaker = parts[0].trim();
            for (let i = 1; i < parts.length; i++) {
                if (parts[i].startsWith('emotion=')) seg.emotion = parts[i].slice(8);
                if (parts[i].startsWith('context=')) seg.context = parts[i].slice(8);
                if (parts[i].startsWith('scale=')) seg.emotionScale = parseFloat(parts[i].slice(6));
            }
        } else {
            seg.speaker = params.trim();
        }
        
        lastIndex = regex.lastIndex;
        // 需要继续读取到下一个标签或结尾
        segments.push(seg);
    }
    
    // 添加剩余文本
    if (lastIndex < text.length) {
        segments.push({
            text: text.slice(lastIndex),
            speaker: '',
            emotion: '',
            context: ''
        });
    }
    
    return segments.filter(s => s.text.trim());
}
```

---

## 四、API调用

### 4.1 火山引擎 V3 API（tts-api.js:1-100）
```javascript
const V3_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const FREE_V1_URL = 'https://edgetts.velure.codes';

export const FREE_VOICES = [
    { key: 'female_1', name: '晓晓', tag: '温暖百变', gender: 'female' },
    { key: 'male_1', name: '云希', tag: '少年温暖', gender: 'male' },
    // ... 更多音色
];

export async function synthesizeV3(params, authHeaders = {}) {
    const {
        appId,
        accessKey,
        resourceId = 'seed-tts-2.0',
        uid = 'st_user',
        text,
        speaker,
        model,
        format = 'mp3',
        sampleRate = 24000,
        speechRate = 0,
        // ... 其他参数
    } = params;
    
    if (!appId || !accessKey || !text || !speaker) {
        throw new Error('缺少必要参数: appId/accessKey/text/speaker');
    }
    
    // 构建请求体
    const payload = {
        app: {
            appid: appId,
            token: accessKey,
            cluster: resourceId
        },
        audio: {
            voice: speaker,
            rate: speechRate,
            audio_format: format,
            sample_rate: sampleRate
        },
        request: {
            reqid: generateUid(),
            text: text,
            // ... 其他参数
        }
    };
    
    // 发送请求
    const response = await fetch(V3_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${await getToken(appId, accessKey)}`,
            ...authHeaders
        },
        body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
        throw new Error(`TTS API error: ${response.status}`);
    }
    
    const result = await response.json();
    
    // 处理返回的音频数据（通常是base64）
    if (result.data?.audio) {
        const audioBase64 = result.data.audio;
        const byteString = atob(audioBase64);
        const bytes = new Uint8Array(byteString.length);
        for (let j = 0; j < byteString.length; j++) {
            bytes[j] = byteString.charCodeAt(j);
        }
        const audioBlob = new Blob([bytes], { type: 'audio/mpeg' });
        return { audioBlob, usage: result.usage };
    }
    
    throw new Error('No audio data in response');
}
```

### 4.2 免费音色 API（tts-api.js）
```javascript
export async function synthesizeFreeV1({ text, voiceKey, speed, emotion }) {
    const url = `${FREE_V1_URL}/synthesize`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            voice: voiceKey,
            speed: speed || 1.0,
            emotion: emotion || ''
        })
    });
    
    if (!response.ok) throw new Error(`Free TTS error: ${response.status}`);
    
    const result = await response.json();
    return { audioBase64: result.audio };
}
```

### 4.3 使用代理（tts-api.js:37-40）
```javascript
async function proxyFetch(url, options = {}) {
    const proxyUrl = '/proxy/' + encodeURIComponent(url);
    return fetch(proxyUrl, options);
}
```

---

## 五、音频播放

### 5.1 TTS播放器类（tts-player.js:5-100）
```javascript
export class TtsPlayer {
    constructor() {
        this.queue = [];
        this.currentAudio = null;
        this.currentItem = null;
        this.currentStream = null;
        this.currentCleanup = null;
        this.isPlaying = false;
        this.onStateChange = null; // 回调：(state, item, info) => void
    }
    
    /**
     * 入队
     * @param {Object} item - { id, audioBlob, text? }
     * @returns {boolean} 是否成功入队（重复id会跳过）
     */
    enqueue(item) {
        if (!item?.audioBlob && !item?.streamFactory) return false;
        // 防重复
        if (item.id && this.queue.some(q => q.id === item.id)) {
            return false;
        }
        this.queue.push(item);
        this._notifyState('enqueued', item);
        if (!this.isPlaying) {
            this._playNext();
        }
        return true;
    }
    
    /**
     * 清空队列并停止播放
     */
    clear() {
        this.queue = [];
        this._stopCurrent(true);
        this.currentItem = null;
        this.isPlaying = false;
        this._notifyState('cleared', null);
    }
    
    /**
     * 获取队列长度
     */
    get length() {
        return this.queue.length;
    }
    
    /**
     * 立即播放（打断队列）
     * @param {Object} item
     */
    playNow(item) {
        if (!item?.audioBlob && !item?.streamFactory) return false;
        this.queue = [];
        this._stopCurrent(true);
        this._playItem(item);
        return true;
    }
    
    /**
     * 切换播放（同一条则暂停/继续）
     * @param {Object} item
     */
    toggle(item) {
        if (!item?.audioBlob && !item?.streamFactory) return false;
        if (this.currentItem?.id === item.id && this.currentAudio) {
            if (this.currentAudio.paused) {
                this.currentAudio.play().catch(err => {
                    console.warn('[TTS Player] 播放被阻止（需用户手势）:', err);
                    this._notifyState('blocked', item);
                });
            } else {
                this.currentAudio.pause();
            }
            return true;
        }
        return this.playNow(item);
    }
    
    _playNext() {
        if (this.queue.length === 0) {
            this.isPlaying = false;
            this.currentItem = null;
            this._notifyState('idle', null);
            return;
        }
        
        const item = this.queue.shift();
        this._playItem(item);
    }
    
    _playItem(item) {
        this.isPlaying = true;
        this.currentItem = item;
        this._notifyState('playing', item);
        
        if (item.streamFactory) {
            // 流式播放
            const { stream, cleanup } = item.streamFactory();
            this.currentStream = stream;
            this.currentCleanup = cleanup;
            // ... 流式播放逻辑
        } else if (item.audioBlob) {
            // Blob播放
            const url = URL.createObjectURL(item.audioBlob);
            const audio = new Audio(url);
            this.currentAudio = audio;
            
            audio.onended = () => {
                URL.revokeObjectURL(url);
                this._playNext();
            };
            
            audio.onerror = () => {
                URL.revokeObjectURL(url);
                this._notifyState('error', item, { error: '播放失败' });
                this._playNext();
            };
            
            audio.play().catch(err => {
                console.warn('[TTS Player] 播放失败:', err);
                URL.revokeObjectURL(url);
                this._notifyState('error', item, { error: err.message });
                this._playNext();
            });
        }
    }
    
    _stopCurrent(notify = false) {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.src = '';
            this.currentAudio = null;
        }
        if (this.currentCleanup) {
            this.currentCleanup();
            this.currentCleanup = null;
        }
        if (this.currentStream) {
            this.currentStream = null;
        }
        if (notify) {
            this._notifyState('stopped', this.currentItem);
        }
    }
    
    _notifyState(state, item, info = {}) {
        if (this.onStateChange) {
            this.onStateChange(state, item, info);
        }
    }
}
```

---

## 六、缓存机制

### 6.1 IndexedDB缓存（tts-cache.js）
```javascript
// 缓存键生成
function buildCacheKey(params) {
    const payload = {
        providerMode: params.providerMode || 'auth',
        text: params.text || '',
        speaker: params.speaker || '',
        resourceId: params.resourceId || '',
        format: params.format || 'mp3',
        sampleRate: params.sampleRate || 24000,
        speechRate: params.speechRate || 0,
        // ... 其他参数
    };
    return `tts:${hashString(JSON.stringify(payload))}`;
}

// 获取缓存
async function getCacheEntry(key) {
    // 从IndexedDB读取
    const db = await openDB();
    const tx = db.transaction('tts-cache', 'readonly');
    const store = tx.objectStore('tts-cache');
    return await store.get(key);
}

// 设置缓存
async function setCacheEntry(key, blob, meta) {
    const entry = {
        key,
        blob,
        meta,
        createdAt: Date.now()
    };
    const db = await openDB();
    const tx = db.transaction('tts-cache', 'readwrite');
    const store = tx.objectStore('tts-cache');
    await store.put(entry);
}

// 清理过期缓存
async function clearExpiredCache(days = 7) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const db = await openDB();
    const tx = db.transaction('tts-cache', 'readwrite');
    const store = tx.objectStore('tts-cache');
    // ... 删除过期条目
}
```

---

## 七、音色解析

### 7.1 音色来源判断（tts.js:237-303）
```javascript
function getVoiceSource(value) {
    if (!value) return 'free';
    if (FREE_VOICE_KEYS.has(value)) return 'free';
    return 'auth';
}

function isAuthConfigured() {
    return !!(config?.volc?.appId && config?.volc?.accessKey);
}

function resolveSpeakerWithSource(speakerName, mySpeakers, defaultSpeaker) {
    const list = Array.isArray(mySpeakers) ? mySpeakers : [];
    
    // 如果未指定音色，使用默认音色
    if (!speakerName) {
        const defaultItem = list.find(s => s.value === defaultSpeaker);
        return {
            value: defaultSpeaker,
            source: defaultItem?.source || getVoiceSource(defaultSpeaker),
            resourceId: defaultItem?.resourceId || null
        };
    }
    
    // 按名称查找
    const byName = list.find(s => s.name === speakerName);
    if (byName?.value) {
        return {
            value: byName.value,
            source: byName.source || getVoiceSource(byName.value),
            resourceId: byName.resourceId || null
        };
    }
    
    // 按值查找
    const byValue = list.find(s => s.value === speakerName);
    if (byValue?.value) {
        return {
            value: byValue.value,
            source: byValue.source || getVoiceSource(byValue.value),
            resourceId: byValue.resourceId || null
        };
    }
    
    // 免费音色键
    if (FREE_VOICE_KEYS.has(speakerName)) {
        return { value: speakerName, source: 'free', resourceId: null };
    }
    
    // 回退到默认音色
    const defaultItem = list.find(s => s.value === defaultSpeaker);
    return {
        value: defaultSpeaker,
        source: defaultItem?.source || getVoiceSource(defaultSpeaker),
        resourceId: defaultItem?.resourceId || null
    };
}
```

---

## 八、制作自己的TTS插件要点

### 8.1 最小实现清单

| 功能 | 实现方式 | 参考文件 |
|------|----------|----------|
| 插件声明 | manifest.json 设置 `js`, `css` | manifest.json |
| 触发TTS | 监听 `CHARACTER_MESSAGE_RENDERED` 事件 | tts.js:1350 |
| 获取消息 | `getContext().chat[messageId]` | tts.js:403-406 |
| 提取文本 | 过滤HTML，提取纯文本 | tts-text.js:9-19 |
| 选择音色 | 配置默认音色，支持 `[tts:speaker]` 指令 | tts.js:629-639 |
| 调用API | 选择TTS服务商(火山/Azure/百度)，封装请求 | tts-api.js:51-100 |
| 播放音频 | `new Audio(blobUrl)` 或 AudioContext | tts-player.js |
| 队列管理 | 数组+当前播放索引，支持连续播放 | tts-player.js |
| 缓存 | IndexedDB存储已合成音频，避免重复请求 | tts-cache.js |
| UI面板 | 设置界面，音色选择，播放控制 | tts-panel.js |

### 8.2 简化的TTS插件结构
```
my-tts-plugin/
├── manifest.json       # 插件声明
├── index.js            # 主入口，事件监听
├── tts-core.js         # TTS合成核心逻辑
├── tts-player.js      # 音频播放器
└── style.css           # 样式（可选）
```

### 8.3 最简实现代码示例

**manifest.json**
```json
{
    "display_name": "我的TTS插件",
    "loading_order": 10,
    "js": "index.js",
    "css": "style.css",
    "author": "Your Name",
    "version": "1.0.0",
    "description": "简单的TTS语音插件"
}
```

**index.js**
```javascript
// 全局变量
let player = null;
const MODULE_NAME = 'my_tts';

// 初始化
jQuery(() => {
    const { eventSource, event_types } = SillyTavern.getContext();
    
    // 创建播放器
    player = new TtsPlayer();
    
    // 监听消息渲染事件
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (data) => {
        await handleMessageRendered(data);
    });
    
    console.log('[My TTS] 插件已加载');
});

// 处理消息渲染
async function handleMessageRendered(data) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        const messageId = data.messageId ?? (chat.length - 1);
        
        if (!Number.isFinite(messageId)) return;
        
        const message = chat[messageId];
        if (!message || message.is_user) return;
        
        // 提取文本
        const text = extractText(message.mes);
        if (!text.trim()) return;
        
        // 调用TTS API
        const audioBlob = await synthesizeTTS(text);
        if (!audioBlob) return;
        
        // 播放
        player.enqueue({ id: `msg-${messageId}`, audioBlob, text });
    } catch (err) {
        console.error('[My TTS] 错误:', err);
    }
}

// 提取文本（简化版）
function extractText(rawText) {
    if (!rawText) return '';
    // 简单过滤HTML标签
    return rawText.replace(/<[^>]*>/g, '').trim();
}

// TTS合成（示例：调用火山引擎）
async function synthesizeTTS(text) {
    // 这里替换为你的TTS API调用
    // 示例：返回mock的audio blob
    try {
        const response = await fetch('/your-tts-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        
        if (!response.ok) throw new Error('TTS API error');
        return await response.blob();
    } catch (err) {
        console.error('[My TTS] 合成失败:', err);
        return null;
    }
}

// 简单的播放器类
class TtsPlayer {
    constructor() {
        this.queue = [];
        this.isPlaying = false;
    }
    
    enqueue(item) {
        if (!item?.audioBlob) return;
        this.queue.push(item);
        if (!this.isPlaying) {
            this._playNext();
        }
    }
    
    _playNext() {
        if (this.queue.length === 0) {
            this.isPlaying = false;
            return;
        }
        
        this.isPlaying = true;
        const item = this.queue.shift();
        const url = URL.createObjectURL(item.audioBlob);
        const audio = new Audio(url);
        
        audio.onended = () => {
            URL.revokeObjectURL(url);
            this._playNext();
        };
        
        audio.play().catch(err => {
            console.warn('[My TTS] 播放失败:', err);
            URL.revokeObjectURL(url);
            this._playNext();
        });
    }
}
```

---

## 九、其他TTS服务商参考

### 9.1 Azure TTS
```javascript
const AZURE_URL = 'https://<region>.tts.speech.microsoft.com/cognitiveservices/v1';

async function synthesizeAzure(text, voiceName, subscriptionKey) {
    const ssml = `
        <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>
            <voice name='${voiceName}'>${text}</voice>
        </speak>
    `;
    
    const response = await fetch(AZURE_URL, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': subscriptionKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
        },
        body: ssml
    });
    
    return await response.blob();
}
```

### 9.2 百度TTS
```javascript
const BAIDU_URL = 'http://tsn.baidu.com/text2audio';

async function synthesizeBaidu(text, token, voice = 0) {
    const params = new URLSearchParams({
        tex: text,
        tok: token,
        cuid: 'sillytavern-user',
        ctp: 1,
        lan: 'zh',
        spd: 5,  // 语速 0-15
        pit: 5,  // 音调 0-15
        vol: 5,  // 音量 0-15
        per: voice, // 发音人 0-4
        aue: 3     // 格式 3=mp3
    });
    
    const response = await fetch(`${BAIDU_URL}?${params}`, {
        method: 'GET'
    });
    
    return await response.blob();
}
```

### 9.3 Edge TTS（免费，无需API key）
```javascript
// 使用 edge-tts 或其他免费服务
// 或者通过代理调用
```

---

## 十、注意事项

1. **跨域问题**：浏览器直接调用TTS API可能遇到CORS问题，建议使用SillyTavern的代理功能：
   ```javascript
   const proxyUrl = '/proxy/' + encodeURIComponent(apiUrl);
   ```

2. **用户手势要求**：浏览器要求音频播放必须由用户手势触发。解决方案：
   - 在用户点击消息时播放
   - 使用 `AudioContext` 并在用户首次交互时初始化
   - 显示一个播放按钮让用户点击

3. **性能优化**：
   - 对已合成的文本进行缓存
   - 长文本分段合成和播放
   - 使用队列管理并发请求

4. **错误处理**：
   - API调用失败时的重试机制
   - 网络错误的友好提示
   - 无效的音频数据检测

5. **配置存储**：使用 `extensionSettings` 持久化用户配置：
   ```javascript
   const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
   extensionSettings[MODULE_NAME] = { apiKey: '...', voice: '...' };
   saveSettingsDebounced();
   ```

---

## 十一、参考资源

- LittleWhiteBox 插件GitHub: https://github.com/RT15548/LittleWhiteBox
- SillyTavern 官方文档: https://docs.sillytavern.app/
- 火山引擎TTS文档: https://www.volcengine.com/docs/6561/97465
- Azure TTS文档: https://learn.microsoft.com/azure/cognitive-services/speech-service/
- 百度TTS文档: https://ai.baidu.com/tech/speech/tts

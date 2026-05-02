# 自动TTS循环任务 - 开发总结

## 项目结构

```
自动TTS循环任务/
├── auto-tts-loop.js    # TaskJS脚本（核心代码）
├── README.md           # 使用说明
└── DEBUG.md            # 本文档
```

## 依赖关系

```
自动TTS循环任务 (TaskJS脚本)
    │
    ├── 小白X扩展 (循环任务框架)
    │   ├── addFloorListener()  ← 监听AI回复
    │   └── 任务栏按钮 ← 打开设置面板
    │
    ├── LittleWhiteBox插件 (TTS)
    │   ├── window.xiaobaixTts.player.onStateChange ← 监听TTS状态
    │   └── .xb-tts-btn.play-btn ← 消息上的TTS按钮
    │
    └── SillyTavern 核心
        ├── /script.js → chat, sendTextareaMessage
        ├── #send_textarea ← 输入框
        └── #send_but ← 发送按钮
```

## 关键变量

| 变量 | 作用 | 初始值 |
|------|------|--------|
| `window._r` | 防止重复初始化 | false |
| `s` | 发送锁，防止重复发送 | false |
| `lastTriggered` | 上次触发过发送的消息ID | null |
| `loopCount` | 当前循环次数 | 0 |
| `stopped` | 是否已停止 | false |
| `keepAlive` | 防止TaskJS被回收 | setInterval(...) |
| `cfg` | 配置对象 {text, maxLoop} | localStorage读取 |

## 核心流程

```
点击"开始循环"
    ↓
    1. send() → 输入文本 → 点击发送按钮
    ↓
    2. AI回复 → addFloorListener回调 → 重试查找TTS按钮 → 点击
    ↓
    3. TTS开始播放 → player.onStateChange('playing') → 检查lastTriggered → send()
    ↓
    4. 回到第2步，循环
```

## 关键机制说明

### 1. 防重复触发 (lastTriggered)

LittleWhiteBox会把一条消息的TTS拆成多个段落播放，每个段落都触发 `playing`。用 `lastTriggered` 记录消息ID，同一条消息只触发一次发送。

```javascript
if (state === 'playing' && !s && lastTriggered !== item?.messageId) {
    lastTriggered = item?.messageId;
    send();
}
```

### 2. 防脚本被回收 (keepAlive)

TaskJS脚本执行完 `openPanel()` 即结束。如果不保持存活，`addFloorListener` 回调会被回收失效。

```javascript
const keepAlive = setInterval(() => {}, 60000); // 每60秒空循环一次
```

### 3. TTS按钮延迟查找 (retry)

LittleWhiteBox用IntersectionObserver懒加载TTS按钮，可能在 `after_ai` 触发时还没渲染。用重试机制解决。

```javascript
let retries = 0;
const tryClick = () => {
    const btn = document.querySelector(selector);
    if (btn) { btn.click(); }
    else if (retries < 10) { retries++; setTimeout(tryClick, 300); }
};
```

### 4. 停止机制 (stopped)

点击"停止循环"设置 `stopped = true`，TTS回调和AI监听器都会跳过后续操作。

```javascript
// player.onStateChange中
if (stopped) return;   // ← TTS播放不触发发送

// addFloorListener中
if (stopped) return;   // ← AI回复不点击TTS按钮
```

## DEBUG指南

### 打开控制台

按F12 → Console → Filter框输入 `AutoTTS` 只看我们的日志。

### 常见问题诊断

| 现象 | 可能原因 | 诊断方法 |
|------|----------|----------|
| 开始后什么都没发生 | keepAlive缺失 | 控制台是否有`[AutoTTS]`日志？没有=被回收 |
| 发了一条后不循环 | lastTriggered逻辑问题 | 看日志中`[AutoTTS] AI回复完成`是否出现 |
| TTS不播放 | TTS按钮未渲染 | 看日志中`[AutoTTS] 未找到按钮(retry X/10)` |
| 发了几条后停了 | maxLoop限制 | 检查面板中的循环次数设置 |
| 再点任务栏按钮没反应 | window._r已存在 | 是否有`atts_panel`存在？应该重新显示 |
| 连发多条消息 | 多个TTS段落触发 | 检查`lastTriggered`逻辑是否生效 |

### 关键日志说明

```
[AutoTTS] 已停止，跳过         ← 正常停止，忽略
[AutoTTS] AI回复完成, messageId: 5  ← 监听器工作正常
[AutoTTS] 找到TTS按钮，点击    ← 按钮找到了，TTS应开始
[AutoTTS] 未找到按钮(retry 2/10) ← 按钮还在渲染中
[AutoTTS] 消息元素: 不存在      ← 消息DOM还没出来，可能after_ai时机不对
[AutoTTS] TTS面板: 不存在      ← LittleWhiteBox还没添加面板
[AutoTTS] 10次重试后仍找不到    ← 3秒超时，可能是配置问题
```

### 手动测试命令

在浏览器控制台直接运行这些命令排查：

```javascript
// 1. 检查LittleWhiteBox是否加载
console.log('xiaobaixTts:', window.xiaobaixTts);
console.log('player:', window.xiaobaixTts?.player);

// 2. 手动点击一条消息的TTS按钮
const btn = document.querySelector(`.mes[mesid="最后一条AI消息ID"] .xb-tts-btn.play-btn`);
console.log('按钮:', btn);
btn?.click();

// 3. 手动发送消息
const t = document.getElementById('send_textarea');
t.value = '测试';
t.dispatchEvent(new Event('input', { bubbles: true }));
document.getElementById('send_but').click();

// 4. 查看我们的配置
JSON.parse(localStorage.getItem('auto_tts_cfg'));

// 5. 强制停止
window._autoTtsCleanup?.();
delete window._r;
```

## 版本历史

| 日期 | 变更 |
|------|------|
| 最初 | 基于时间计算的版本 |
| V2 | 改为TTS开始播放就发送（无缝衔接） |
| V3 | 加`lastTriggered`防重复触发 |
| V4 | 加设置面板（开始/停止/关闭） |
| V5 | 加TTS按钮重试查找 |
| V6 | 加`keepAlive`防回收、加debug日志 |

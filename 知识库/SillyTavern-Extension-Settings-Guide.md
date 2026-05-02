# SillyTavern 插件设置面板开发指南

在 SillyTavern（酒馆）中，为插件添加设置面板是提升用户体验的关键。虽然酒馆内核提供了一个极其基础的 `addExtensionControls` 函数，但由于其灵活性极低且文档匮乏，官方示例及主流插件均推荐使用 **“手动挂载（Manual Mounting）”** 方案。

本指南将详细介绍如何按照社区规范添加一个功能完备、样式原生的设置面板。

---

## 1. 为什么选择“手动挂载”？

*   **完全的 UI 控制权**：可以自由定义多标签页、按钮组、复杂的 Grid 布局等。
*   **外观一致性**：通过手动编写原生类名，使插件设置看起来与酒馆原生设置完全一致。
*   **跨版本兼容性**：直接操作 `#extensions_settings` 这一稳定的 DOM 容器，受内核 API 变动的影响最小。
*   **代码解耦**：将 UI 结构留在 HTML 文件中，逻辑留在 JS 文件中，符合现代开发规范。

---

## 2. 标准文件结构

```text
my-plugin/
├── manifest.json    # 插件声明
├── index.js         # 逻辑实现
├── settings.html    # UI 模板
└── style.css        # 自定义样式（可选）
```

---

## 3. 实现步骤

### 第一步：编写设置模板 (`settings.html`)

必须遵循酒馆的 `inline-drawer` 结构，这能自动获得“折叠/展开”功能以及原生的视觉风格。

```html
<!-- 插件面板根容器 -->
<div id="my-plugin-settings" class="inline-drawer">
    <!-- 头部：标题与折叠图标 -->
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>我的插件名称</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>

    <!-- 内容区 -->
    <div class="inline-drawer-content">
        <div class="settings_section">
            <label for="my-plugin-text-input">配置内容：</label>
            <input type="text" id="my-plugin-text-input" class="text_pole" placeholder="请输入...">
        </div>
        
        <!-- 分隔线 -->
        <hr class="sysHR" />
        
        <div class="settings_section flex-container">
            <input type="checkbox" id="my-plugin-checkbox">
            <label for="my-plugin-checkbox">启用某项功能</label>
        </div>
    </div>
</div>
```

### 第二步：逻辑实现 (`index.js`)

核心逻辑包括：**获取上下文** -> **初始化设置** -> **异步读取 HTML** -> **追加到页面** -> **事件绑定**。

```javascript
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { SlashCommand } from "../../../slash-commands/SlashCommand.js";

// 获取酒馆上下文
const context = SillyTavern.getContext();
const { eventSource, event_types, extensionSettings } = context;

const MODULE_NAME = 'my_plugin_id';
const defaultSettings = {
    text: '默认文本',
    enabled: true
};

/**
 * 初始化设置：确保配置对象存在并补全缺失项
 */
function loadSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = {};
    }
    for (const key in defaultSettings) {
        if (extensionSettings[MODULE_NAME][key] === undefined) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
}

/**
 * UI 初始化与挂载
 */
async function initUI() {
    loadSettings();

    try {
        // 1. 读取 HTML 模板文件
        const htmlPath = `/scripts/extensions/third-party/my-plugin/settings.html`;
        const settingsHtml = await $.get(htmlPath);
        
        // 2. 手动挂载到酒馆的设置面板 (#extensions_settings)
        // 注意：酒馆有两个设置列，#extensions_settings 为左列，#extensions_settings2 为右列
        $('#extensions_settings').append(settingsHtml);

        // 3. 绑定 UI 数据与事件
        const $textInput = $('#my-plugin-text-input');
        const $checkbox = $('#my-plugin-checkbox');

        // 设置初始值
        $textInput.val(extensionSettings[MODULE_NAME].text);
        $checkbox.prop('checked', extensionSettings[MODULE_NAME].enabled);

        // 绑定持久化事件
        $textInput.on('input', (e) => {
            extensionSettings[MODULE_NAME].text = $(e.target).val();
            context.saveSettingsDebounced(); // 使用防抖保存
        });

        $checkbox.on('change', (e) => {
            extensionSettings[MODULE_NAME].enabled = $(e.target).prop('checked');
            context.saveSettingsDebounced();
        });

        console.log('[My Plugin] 设置面板挂载完成');
    } catch (error) {
        console.error('[My Plugin] 设置面板挂载失败:', error);
    }
}

// 规范：监听 APP_READY 事件后再操作 DOM
eventSource.on(event_types.APP_READY, initUI);
```

---

## 4. UI 常用原生类名手册

使用以下类名可确保你的插件与酒馆主题（Smart Theme）深度融合：

| 类名 | 描述 |
| :--- | :--- |
| `inline-drawer` | 基础折叠面板，能响应酒馆的全局折叠/展开操作。 |
| `inline-drawer-header` | 带有背景色和交互反馈的头部标题栏。 |
| `settings_section` | 标准行容器，自带适当的上边距和内边距。 |
| `text_pole` | 酒馆标准的文本输入框（深色半透明背景，带圆角）。 |
| `menu_button` | 标准按钮，支持悬浮高亮效果。 |
| `sysHR` | 酒馆标准水平线，颜色会随主题自动调整。 |
| `flex-container` | 快捷 Flex 布局，通常配合 `alignItemsCenter` 使用。 |
| `has-tooltip` | 结合 `data-tooltip="内容"` 属性可实现原生浮窗提示。 |

---

## 5. 开发规范与注意事项

1.  **命名空间隔离**：所有的 ID（`id="..."`）和设置键名（`MODULE_NAME`）必须具有唯一性（建议使用插件名作为前缀），防止与其他插件发生冲突。
2.  **异步加载资源**：HTML 模板应使用 `$.get` 或 `fetch` 异步获取，不要在 JS 里硬编码大量 HTML 字符串。
3.  **遵循生命周期**：始终在 `APP_READY` 事件后执行 DOM 挂载，否则 `#extensions_settings` 容器可能尚未在页面中生成。
4.  **防抖保存**：在监听 `input` 或 `change` 事件时，请务必调用 `context.saveSettingsDebounced()` 而不是同步的保存函数，以减轻服务器 I/O 压力。
5.  **主题适配**：尽量使用 CSS 变量（如 `var(--mainColor)`），这样你的插件能自动适配用户选择的不同酒馆主题。

---

# 网盘有效性检查【重构版】

自动识别页面中的网盘分享链接，检查其有效性，并在链接前显示状态图标。

本项目基于 [Leon406/netdiskChecker](https://github.com/Leon406/netdiskChecker) 重构，核心改动是**彻底修复重复检查与无限创建提示的问题**。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 [`netdisk-checker-rebuild.user.js`](./netdisk-checker-rebuild.user.js)
3. 点击「Raw」，Tampermonkey 会自动弹出安装界面
4. 确认安装

## 支持的网盘

| 网盘 | 状态 |
|---|---|
| 百度网盘 / 百度企业网盘 | ✅ |
| 蓝奏云（含 lanzou / lanzov / lanzn / lanzb / lanpv / lanzoo 等域名） | ✅ |
| 腾讯微云 | ✅ |
| 阿里云盘 / 阿里云快传 | ✅ |
| 天翼云盘 | ✅ |
| 123 网盘（含 123684 / 123865 / 123912） | ✅ |
| 迅雷云盘 | ✅ |
| 夸克网盘 | ✅ |
| 奶牛快传 | ✅ |
| 文叔叔 | ✅ |
| 115 网盘（含 115cdn / anxia） | ✅ |

## 状态图标

| 图标 | 含义 |
|---|---|
| ✅ | 链接有效 |
| 🔒 | 需要提取码 |
| ⚠️ | 部分内容违规 |
| ❌ | 链接已失效 |
| ❓ | 无法判断（网络异常 / 接口变更） |

## 重构要点

### 1. 修复「同一条链接每 0.5 秒无限检查」

**原因**：原版只在请求成功时才写缓存。`state = 0`（请求失败 / 超时 / 无法判断）的结果被直接丢弃，页面每次重新渲染就会再发一次请求。

**修复**：请求**入队那一刻**就记账（`reserve()`），不再依赖回调是否返回。默认 `maxCheckAttempts = 1`，一条链接在本页生命周期内只查一次。

### 2. 修复「每 0.5 秒创建一个提示，无上限」

**原因**：`findAndReplaceDOMText` 匹配前会把整段文字拼接起来。已生成的提示（`<span class="one-pan-tip">`）**内部包含完整链接文字**，下一轮扫描时正则会从提示外部一路匹配进提示内部，于是在旁边再生成一个新提示，下一轮两个都参与匹配，数量不断累积。

**修复**：用 `filterElements` 让提示元素对匹配器**完全不可见**：

```js
filterElements: function (el) {
    if (el.classList && el.classList.contains("one-pan-tip")) return false;
    if (el.hasAttribute && el.hasAttribute("one-tip-mark")) return false;
    ...
}
```

配合 `match.index` 记账，保证「一次匹配 = 一个提示」。

### 3. 扫描模型简化

- 打开页面立刻扫描一次；
- 补扫 4 次（1.5s / 3s / 4.5s / 6s），等懒加载内容；
- 之后进入 DOM 监听，**最多持续 30 秒**，到点自动断开。

任何情况下都不会出现无限扫描。

## 配置

脚本头部的 `manifest` 可直接调整：

```js
"maxConcurrency": 4,      // 最大并发请求数
"maxCheckAttempts": 1,    // 同一条链接最多检查几次（1 = 只查一次）
"retryDelay": 60000,      // 失败后多久才允许重试（毫秒）
"scanPasses": 4,          // 打开页面后补扫几次
"scanInterval": 1500,     // 补扫间隔（毫秒）
"observeDOM": true,       // 是否监听后续 DOM 变化
"observeTimeout": 30000   // 监听最长持续时间（毫秒）
```

滚动加载很深的站点可以把 `observeTimeout` 调大，它始终有上限。

## 测试结果

在 jsdom 中构造的对照测试：

| 场景 | 原版 | 重构版 |
|---|---|---|
| 提示存活 + 持续新增内容 | 提示数量无上限增长 | 1 个 |
| 同一节点强制重扫 20 次 | 增长 | 1 个 |
| 链接文字被切成 20 个 `<span>` | 2 个（嵌套） | 1 个 |
| 40 秒内接口持续失败 | 41 次请求 | 1 次 |
| 请求超时 + 页面每 0.5s 重建 | 持续重试 | 1 次 |
| 页面原始 `<a>` 元素 | — | 完好保留 |

## 许可

AGPL-3.0-or-later，与原项目一致。

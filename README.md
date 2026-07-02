[English](README_EN.md) · [AMO 商店](https://addons.mozilla.org/zh-CN/firefox/addon/brp-bridge-extension/) · [API 文档](docs/API.md)

<br>

> 🔌 **BRP** — 让 AI 助手直接操控你的 Firefox 浏览器。支持 Cursor、Claude、Codex 等任意 MCP 客户端。

---

## 快速开始

### 安装

**方式一：从 Firefox 商店安装**（推荐）

访问 [AMO 商店页面](https://addons.mozilla.org/zh-CN/firefox/addon/brp-bridge-extension/)，点击「添加到 Firefox」。

**方式二：手动安装**

1. 下载最新 [Release](https://github.com/tomjiu/brp-spec/releases) 中的 `brp-extension-v*.xpi`
2. 将 `.xpi` 文件拖入 Firefox 窗口即可安装

### 配置 Bridge

**Windows：**

```powershell
# 运行安装脚本（自动检测浏览器、注册 Native Messaging）
.\install.ps1
```

**Linux / macOS：**

```bash
# 运行安装脚本
bash install.sh
```

安装脚本会自动完成：编译 Bridge → 注册 Native Messaging → 配置完成。

### 连接 AI 客户端（MCP）

在你的 AI 客户端 MCP 配置中添加：

```json
{
  "mcpServers": {
    "brp": {
      "command": "python",
      "args": ["-X", "utf8", "/path/to/brp-spec/adapter/brp_mcp_adapter.py"],
      "env": {
        "BRP_WS_ADDR": "127.0.0.1:9817"
      }
    }
  }
}
```

重新连接 MCP 后，AI 就能操控你的浏览器了。支持 21 个浏览器操作工具：

| 分类 | 工具 |
|------|------|
| 标签页 | `tab_list` `tab_open` `tab_close` `tab_select` |
| 页面 | `navigate` `reload` `go_back` `go_forward` `screenshot` `snapshot` |
| 元素 | `click` `fill` `type` `scroll` `hover` `select` `get_attribute` |
| 键盘 | `key_press` |
| 等待 | `wait_for_selector` |

---

## 功能特性

- **完整标签页管理** — 打开、关闭、切换、列表所有标签页
- **页面操作** — 导航、刷新、前进后退、截图、DOM 交互树抓取
- **元素操控** — CSS/XPath/文本/节点ID 多种选择器，支持点击、输入、滚动、悬停
- **键盘模拟** — 支持组合键（Control+A、Alt+F4 等）
- **安全控制** — 域名黑白名单、敏感信息自动模糊、操作权限对话框
- **多浏览器支持** — 同一 Bridge 可同时连接 Firefox 和 Zen Browser
- **自动发现** — MCP 适配器自动发现已有 Bridge，无需手动管理

---

## 架构

```
AI 客户端 (MCP/Claude/Cursor)
    │  stdin/stdout (JSON-RPC 2.0)
    ▼
MCP 适配器 (brp_mcp_adapter.py)
    │  WebSocket / Native Messaging
    ▼
Rust Bridge (brp-bridge)
    │  WebSocket (127.0.0.1:9817)
    ▼
Firefox Extension (TypeScript)
    │  WebExtension API
    ▼
用户的真实浏览器 (Cookie、登录态、标签页)
```

---

## 开发

### 环境要求

- **Rust** ≥ 1.85
- **Node.js** ≥ 20
- **Python** ≥ 3.10 (MCP 适配器)

### 构建

```bash
# Bridge
cd bridge && cargo build --release

# Extension
cd extension && npm ci && npm run build

# 开发模式加载扩展
# Firefox → about:debugging → 加载临时附加组件 → 选择 extension/manifest.json
```

### 测试

```bash
# Bridge 单元测试 (67+ tests)
cd bridge && cargo test

# Extension 单元测试 (277 tests)
cd extension && npm test

# 完整链路测试
python -X utf8 test_brp_chain.py
```

### 项目结构

```
brp-spec/
├── bridge/           # Rust Bridge — JSON-RPC 路由、WebSocket 服务
├── extension/        # Firefox Extension — TypeScript → esbuild
├── adapter/          # MCP 适配器 — 连接 AI 客户端与 Bridge
├── docs/             # 协议文档、架构说明
├── install.ps1       # Windows 一键安装脚本
└── install.sh        # Linux/macOS 一键安装脚本
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BRP_WS_ADDR` | `127.0.0.1:9817` | WebSocket 服务地址 |
| `BRP_AUTH_TOKEN` | 自动生成 | 认证令牌 |
| `BRP_ALLOW_SCRIPT_EXECUTE` | `0` | 设为 `1` 启用脚本执行 |
| `BRP_STANDALONE` | `0` | 设为 `1` 纯 WS 模式 |
| `RUST_LOG` | `info` | 日志级别 |

---

## 安全

详见 [SECURITY.md](SECURITY.md)

- ✅ 强制 Token 认证 — 所有连接必须提供有效令牌
- ✅ 域名白名单/黑名单 — 精细的页面访问控制
- ✅ URL Scheme 守卫 — 阻止 `javascript:` `file:` 等危险协议
- ✅ 输入验证 — 选择器、文本、URL 均有类型和长度校验
- ✅ 敏感信息脱敏 — 密码、信用卡等字段自动标记 `[REDACTED]`
- ✅ 脚本执行默认关闭 — 需显式设置环境变量开启
- ✅ 连接速率限制 — 防止暴力连接攻击

---

## License

MIT

# BRP 中文文档

> 本文档是 BRP (Browser Runtime Protocol) 的中文导航页。
> 英文主文档位于项目根目录和 `docs/` 下。

## 项目简介

BRP 是一个 **Firefox 浏览器 AI 控制插件**。
通过 Rust Bridge + Firefox Extension，让 AI Agent（Claude、Cursor、Codex 等）直接操控你的真实浏览器。

## 文档导航

| 文档 | 英文 | 说明 |
|------|------|------|
| 架构设计 | [ARCHITECTURE.md](ARCHITECTURE.md) | 组件职责、Discovery 流程、统一 Bridge 模型 |
| 恢复协议 | [RECOVERY_PROTOCOL.md](RECOVERY_PROTOCOL.md) | 只报告事实、不推断原因、2 个标准 Recovery Reason |
| 实现差距 | [IMPLEMENTATION_GAP.md](IMPLEMENTATION_GAP.md) | RFC 章节 vs 代码实现的对照表 |
| 使用模式 | [USAGE-MODES.md](USAGE-MODES.md) | B1 自动链接、Standalone 独立模式、Discovery 统一模式 |
| API 文档 | [API.md](API.md) | JSON-RPC 协议完整参考 |
| 安全加固 | [SECURITY-HARDENING-PLAN.md](SECURITY-HARDENING-PLAN.md) | v0.9 安全修复记录 |
| 路线图 | [ROADMAP.md](ROADMAP.md) | 版本计划 |
| 更新日志 | [../CHANGELOG.md](../CHANGELOG.md) | 所有版本变更 |

## 快速理解

```
你的 AI Agent（Claude）
    ↓ MCP 协议
MCP Adapter（Python）
    ↓ Discovery → 锁定唯一 Bridge
Bridge（Rust 单例）
    ↓ WebSocket
Firefox Extension（TypeScript）
    ↓
你的浏览器
```

## v0.9.0 核心概念

### Bridge Discovery
MCP Adapter 启动时先查找已运行的 Bridge（通过 lockfile），找到就复用，找不到才启动新的。**永远只有一个 Bridge**。

### Recovery Protocol
协议只报告**可观察的事实**（如 `extension_not_connected`），绝不猜测原因（不会说 `extension_disabled` 或 `native_host_broken`）。

### Error Category
所有错误包含 `category` 分类字段：`AUTH`（鉴权）、`CAPABILITY`（能力）、`PERMISSION`（权限）、`TARGET`（目标）、`INTERNAL`（内部）。

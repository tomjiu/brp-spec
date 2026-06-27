# RFC0001 — BRP Core Protocol 优化建议

> **状态**: Draft-01
> **来源**: [ChatGPT 对话](https://chatgpt.com/share/6a3e992a-3708-83ee-8f70-e7ea1927abd0)
> **日期**: 2026-06-26

本文档整理了针对 BRP RFC0001 (Core Protocol) 的 12 项核心优化建议。这些建议直击分布式与事件驱动协议设计的核心痛点，目标是将 BRP 从"具体工具的设计文档"提升为具备开放标准潜力的协议规范。

---

## 综合评价

当前 RFC0001 草案已经接近**开放标准草案级别**，足够放到 GitHub 当做公开 RFC 讨论。但在以下四个基础部分补齐之前，距离真正的协议规范（Protocol Specification）仍有差距：

1. Message Model（消息模型）
2. Action Namespace（动作命名空间）
3. Capability as Feature（能力特性化）
4. Forward Compatibility（前向兼容性）

---

## 建议 1：定义统一的 Message Model

**问题**：当前已定义了 Lifecycle、Event、Selector、URI、Error 等概念，但缺少统一的消息模型。`initialize` 写了一半，`event` 写了一半，`error` 写了一半，而 Action 完全没有定义。这会导致使用者不知道 `executeScript`、`click`、`closeTab` 等具体操作应该如何发送。

**建议**：RFC 应该一开始就定义消息分类：

```
Message
├── Request
├── Response
├── Notification
└── Error
```

**示例**：

Request:
```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tab.click",
  "params": { ... }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "result": {}
}
```

Notification:
```json
{
  "jsonrpc": "2.0",
  "method": "notification.navigationCompleted",
  "params": {}
}
```

这样整个协议瞬间统一，所有操作都有明确的发送格式。

---

## 建议 2：建立 Namespace 命名规范

**问题**：目前没有任何 API 命名规范。未来不同实现者可能写成 `click`、`tab.click` 或 `browser.click`，最终一定会混乱。

**建议**：RFC0001 就规定命名空间：

```
runtime.*
workspace.*
window.*
tab.*
frame.*
page.*
element.*
download.*
storage.*
network.*
```

**示例**：

- `tab.open` / `tab.close`
- `page.navigate`
- `element.click` / `element.fill`
- `network.getCookies`

未来几十个 API 都不用重新讨论命名。LSP 当年就是这么做的。

---

## 建议 3：Capabilities 改为 Feature 列表

**问题**：当前使用布尔值表示能力：

```json
{
  "vision": true
}
```

**建议**：全部改成 Feature 数组：

```json
{
  "capabilities": {
    "features": [
      "events",
      "interactionTree",
      "vision",
      "download",
      "network",
      "screenshot"
    ]
  }
}
```

未来 `accessibility`、`clipboard`、`filesystem`、`proxy` 等能力都能直接扩展。这是协议设计中最经典的 **Forward Compatibility** 模式。

---

## 建议 4：Selector 支持降级链（Fallback Chain）

**问题**：很多 AI 会生成 `role` 类型的 selector，如果失败就退化为 `css`，再失败退化为 `xpath`，但目前协议没有定义这种降级机制。

**建议**：支持 selector 数组形式的降级链：

```json
{
  "selectors": [
    { "type": "role", ... },
    { "type": "css", ... },
    { "type": "xpath", ... }
  ]
}
```

Bridge 自行按顺序尝试，AI 不需要重发请求。这能**明显降低 token 消耗**。

---

## 建议 5：引入 Revision 机制进行增量同步

**问题**：当前有 `treeRevision` 字段，但没有定义增量更新机制。每发生一点 DOM 修改，AI 都要重新下载整个 Tree，数据量会爆炸。

**建议**：引入类 Git 的 revision 机制：

```
treeRevision: 81
```

后续 DOM 变化时：

- Bridge 产生 `revision 82`
- Client 声明"我还是 81"
- Bridge 只发送 delta（差异）

这正是 Git、VSCode、Chrome Accessibility Tree 等系统都会做的事情。

---

## 建议 6：明确 NodeId 生命周期

**问题**：当前定义了 `nodeId` 但没有说明它什么时候失效。使用者不知道 `nodeId` 可以缓存多久。

**建议**：明确规范：

- `nodeId` 仅保证**同一 revision 内稳定**
- **navigation 后全部失效**
- Bridge 可以重新分配

---

## 建议 7：Event 排序引入 Sequence Number

**问题**：当前使用 `timestamp` 标记事件，但 timestamp 不保证顺序。

**建议**：引入 `sequence` + `revision` 字段：

```json
{
  "sequence": 129,
  "revision": 82
}
```

客户端可以检测序列完整性：收到 127、128、130，发现 129 丢失，立即触发 `refreshTree`。这是事件驱动协议常见的**恢复机制**。

---

## 建议 8：定义 Error Recovery 流程

**问题**：RFC 中定义了错误码（如 `BRB_CONTEXT_DESTROYED`），但没有规范客户端应该如何恢复。

**建议**：对每种异常定义标准恢复流程：

```
出现 BRP_CONTEXT_DESTROYED 时，Client SHOULD:
1. reconnect
2. refreshTree
3. retry action
```

这样不同 IDE/客户端行为一致。

---

## 建议 9：Transport Layer 抽象独立

**问题**：已经写了 Zero-Port 设计，但 Transport Layer 没有单独成章。

**建议**：单独定义 Transport Layer 规范：

```
Transport MUST be full duplex.
Transport MUST preserve ordering.
Transport MUST support notifications.
Transport MAY be:
  - Native Messaging
  - Unix Socket
  - Named Pipe
  - WebSocket
  - stdio
  - QUIC
```

这使得协议完全独立于传输方式，未来 Rust Bridge、Go Bridge、Node Bridge 全部一致。

---

## 建议 10：语义化版本控制与兼容规则

**问题**：当前定义了 `protocolVersion`，但没有定义兼容规则。

**建议**：采用 Major.Minor.Patch 语义化版本：

```
Bridge 支持：>= 1.0, < 2.0
```

并明确写入：

> **Unknown fields MUST be ignored.**

这一句几乎所有现代协议都会写，能极大增强兼容性。

---

## 建议 11：Error Code 命名一致性

**问题**：协议已经从 BRB 改名为 BRP，但错误码仍使用旧前缀。

**建议**：全部统一为 BRP 前缀：

```
BRP_PERMISSION_DENIED
BRP_CONTEXT_DESTROYED
BRP_ELEMENT_INTERSECTED
```

保持一致性。

---

## 建议 12：RFC 文档拆分与组织

**问题**：目前 RFC0001 已经接近饱和，不应继续往里塞 API。

**建议**：直接拆分为多个 RFC 文档：

| RFC | 标题 | 内容 |
|-----|------|------|
| RFC0001 | Core Protocol | 消息模型、生命周期、版本协商 |
| RFC0002 | Core Actions | tab/page/element 等动作定义 |
| RFC0003 | Interaction Tree | 交互树结构与同步机制 |
| RFC0004 | Security Model | 安全模型与权限控制 |
| RFC0005 | Native Messaging Transport | 传输层实现规范 |
| RFC0006 | Gecko Runtime Mapping | Firefox/Gecko 运行时映射 |
| RFC0007 | Chromium Runtime Mapping | Chromium 运行时映射 |
| RFC0008 | Capability Registry | 能力注册表 |
| RFC0009 | Selector Registry | 选择器注册表 |

这会让整个项目的专业度提升一个档次，也符合大型开放协议（LSP、DAP）的文档组织方式。

---

## 后续实施路线

1. **RFC0000** Process — ✅ 已完成
2. **RFC0001** Core Protocol Draft-01 — 优化建议已整理
3. **RFC0002** Core Actions — 下一步
4. **RFC0003** Interaction Tree — 待写
5. **RFC0004** Security Model — 待写
6. **RFC0005** Transport — 待写
7. **RFC0006** Capability Negotiation — 待写
8. **RFC0007** Extensions — 待写

等 RFC0001 ~ RFC0003 完成后，可发布 Implementer's Draft，并同步完成 Rust SDK、TypeScript SDK、Firefox Bridge、Chromium Bridge 和示例客户端。

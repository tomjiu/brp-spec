# BRP Protocol API

> **Status**: Stable (API Freeze v0.9.0)
> **Protocol Version**: 0.9.0
>
> No breaking changes to methods, error codes, or message format since v0.8.0.
> New methods may be added (additive only).

## New in v0.9.0
- Capability Enforcement (§2.1.1): Bridge enforces negotiated capabilities
- Version Negotiation (§2.1): Proper semver-based negotiation
- Session Recovery (§2.1.3): Session ID reuse + 30s retention
- Permission Model v2 (§7): Fine-grained permission control
- Multi-Instance (§8): Multiple browser instances per Bridge

---

## 1. Overview

BRP (Browser Runtime Protocol) is a JSON-RPC 2.0 protocol for AI agent browser
interaction. It uses a Bridge ↔ Extension architecture:

```
MCP Adapter ──(native msg)──> Bridge ──(WS)──> Extension ──> Firefox
```

All messages follow the [JSON-RPC 2.0](https://www.jsonrpc.org/specification) specification.

### 1.1 Message Format

Every message is a JSON-RPC 2.0 object:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "page.navigate",
  "params": { "url": "https://example.com" }
}
```

Responses include either `result` or `error`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "uri": "https://example.com", "title": "Example" }
}
```

---

## 2. Lifecycle Methods

### 2.1 initialize

Establish a session with the extension.

**Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "0.1.0",
    "clientInfo": { "name": "brp-client", "version": "1.0.0" }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "ext-a1b2c3",
    "protocolVersion": "0.1.0",
    "negotiatedVersion": "0.1.0",
    "serverInfo": { "name": "brp-extension-gecko", "version": "0.1.0" },
    "capabilities": {
      "features": ["interactionTree", "events", "screenshot"],
      "actions": ["page.navigate", "element.click", "...", "history.delete"],
      "treeDeltaSupported": false,
      "multiSession": false,
      "maxRequestSize": null
    }
  }
}
```

**Capability Negotiation**: The bridge computes the intersection of client-requested actions and extension-supported actions (reported dynamically from `METHOD_ROUTES`). The returned `capabilities.actions` list is the negotiated set. After initialization, the bridge enforces these — calling a method outside the negotiated set returns `-32005 BRP_CAPABILITY_NOT_SUPPORTED`. If the client sends no capabilities, the bridge defaults to all extension-supported actions (backward compatible).

### 2.1.1 Capability Enforcement

After `initialize`, the Bridge enforces negotiated capabilities on all methods forwarded to the Extension. Methods handled locally by the Bridge (`initialize`, `shutdown`, `exit`, `token.*`, `browser.list`) are exempt from capability checks.

If a client calls a method not in the negotiated capability set, the Bridge returns:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32005,
    "message": "Method not supported by negotiated capabilities: {method}",
    "data": {
      "errorCode": "BRP_CAPABILITY_NOT_SUPPORTED",
      "retriable": false,
      "recoveryHint": "Check initialize response for supported actions"
    }
  }
}
```

### 2.2 shutdown

Gracefully end a session.

**Request**: `{ "method": "shutdown" }`
**Response**: `{ "result": {} }`

---

## 3. Page Methods

| Method | Description | Params |
|--------|-------------|--------|
| `page.navigate` | Navigate to URL | `url`, `tabId?` |
| `page.getInteractionTree` | Get DOM interaction tree | `tabId?`, `selector?` |
| `page.screenshot` | Capture page screenshot | `tabId?` |
| `page.goBack` | Browser back | `tabId?` |
| `page.goForward` | Browser forward | `tabId?` |
| `page.reload` | Reload current page | `tabId?` |
| `page.waitForSelector` | Wait for element to appear | `selector`, `tabId?`, `timeout?` |

### 3.1 page.navigate

Navigate the browser to a URL.

```json
{
  "method": "page.navigate",
  "params": { "url": "https://example.com" }
}
```

**Response**:
```json
{
  "result": {
    "tabId": 1,
    "windowId": 1,
    "uri": "https://example.com",
    "title": "Example Domain",
    "status": "complete"
  }
}
```

### 3.2 page.screenshot

Capture a screenshot of the current page.

```json
{
  "method": "page.screenshot",
  "params": { "tabId": 1 }
}
```

**Response**:
```json
{
  "result": {
    "data": "iVBORw0KGgoAAAANSUhEUgAA...",
    "format": "png",
    "tabId": 1
  }
}
```

`data` is a base64-encoded PNG image.

### 3.3 page.getInteractionTree

Get the DOM interaction tree for the current page.

```json
{
  "method": "page.getInteractionTree",
  "params": { "tabId": 1 }
}
```

**Response**:
```json
{
  "result": {
    "tree": {
      "tag": "body",
      "children": [
        { "tag": "button", "text": "Login", "actionable": true }
      ]
    }
  }
}
```

### 3.4 page.goBack / page.goForward / page.reload

Navigation history methods (no params beyond optional `tabId`):

```json
{ "method": "page.goBack", "params": {} }
{ "method": "page.goForward", "params": {} }
{ "method": "page.reload", "params": {} }
```

**Response**: `{ "result": { "uri": "...", "title": "..." } }`

### 3.5 page.waitForSelector

Wait for a CSS selector to appear in the DOM.

```json
{
  "method": "page.waitForSelector",
  "params": {
    "selector": { "type": "css", "value": "#login-btn" },
    "timeout": 5000
  }
}
```

**Response**: `{ "result": { "found": true } }`

---

## 4. Element Methods

All element methods require a `selector` to identify the target element.

| Method | Description | Additional Params |
|--------|-------------|-------------------|
| `element.click` | Click an element | `precondition?` |
| `element.type` | Type text (keystrokes) | `value`, `delay?` |
| `element.fill` | Fill input value | `value`, `clearFirst?` |
| `element.scroll` | Scroll element into view | — |
| `element.hover` | Hover over element | — |
| `element.select` | Select option | `value` |
| `element.getAttribute` | Get element attribute | `name` |

### 4.1 Selector Format

```json
{
  "selector": {
    "type": "css",
    "value": "#login-btn"
  }
}
```

Supported selector types:
- `css`: CSS selector
- `text`: Text content match
- `xpath`: XPath expression

### 4.2 Precondition (E3)

Optional precondition validates the element before acting:

```json
{
  "method": "element.click",
  "params": {
    "selector": { "type": "css", "value": "#btn" },
    "precondition": {
      "tagName": "BUTTON",
      "textContains": "Submit",
      "attributes": { "data-enabled": "true" }
    }
  }
}
```

Precondition failure returns `BRP_PRECONDITION_FAILED` (E3).

### 4.3 element.click

```json
{
  "method": "element.click",
  "params": {
    "selector": { "type": "css", "value": "#login-btn" },
    "tabId": 1
  }
}
```

**Response**: `{ "result": { "matchedSelector": { "type": "css", "value": "#login-btn" } } }`

### 4.4 element.fill

```json
{
  "method": "element.fill",
  "params": {
    "selector": { "type": "css", "value": "#username" },
    "value": "testuser",
    "clearFirst": true,
    "tabId": 1
  }
}
```

**Response**: `{ "result": { "matchedSelector": { "type": "css", "value": "#username" } } }`

### 4.5 element.type

Type text with simulated keystrokes (respects keyboard events).

```json
{
  "method": "element.type",
  "params": {
    "selector": { "type": "css", "value": "#username" },
    "value": "testuser",
    "delay": 50,
    "tabId": 1
  }
}
```

**Response**: `{ "result": { "matchedSelector": { "type": "css", "value": "#username" } } }`

### 4.6 element.scroll / element.hover / element.select / element.getAttribute

```json
// Scroll element into view
{ "method": "element.scroll", "params": { "selector": {...} } }

// Hover over element
{ "method": "element.hover", "params": { "selector": {...} } }

// Select option in a <select> element
{ "method": "element.select", "params": { "selector": {...}, "value": "option-value" } }

// Get element attribute value
{ "method": "element.getAttribute", "params": { "selector": {...}, "name": "href" } }
```

All return `{ "result": { "matchedSelector": {...} } }` (getAttribute returns `{ "value": "..." }`).

**Note on page-level scrolling**: There is no separate `page.scroll` method. To scroll the page, use `element.scroll` with the `body` selector:
```json
{
  "method": "element.scroll",
  "params": { "selector": { "type": "css", "value": "body" } }
}
```
When called without a selector, `element.scroll` scrolls to the top of the page (`window.scrollTo({ top: 0 })`).



---

## 5. Tab Methods

| Method | Description | Params |
|--------|-------------|--------|
| `tab.list` | List all tabs in current window | — |
| `tab.open` | Open new tab | `url?`, `active?` |
| `tab.close` | Close tab | `tabId?` |
| `tab.select` | Switch to tab | `tabId?`, `pageIdx?` |
| `tab.setControllable` | Toggle tab controllable | `tabId`, `controllable` |

### 5.1 tab.list

**Response**:
```json
{
  "result": {
    "tabs": [
      {
        "tabId": 1,
        "windowId": 1,
        "title": "Example",
        "url": "https://example.com",
        "active": true,
        "status": "complete",
        "controllable": true
      }
    ],
    "count": 1
  }
}
```

### 5.2 tab.open

Opens a new tab. AI-opened tabs are automatically marked as controllable.

```json
{
  "method": "tab.open",
  "params": { "url": "https://example.com", "active": true }
}
```

**Response**:
```json
{
  "result": { "tabId": 2, "windowId": 1, "url": "https://example.com" }
}
```

### 5.3 tab.close / tab.select

Close the current tab or switch to another tab.

```json
// Close active tab (or specify tabId)
{ "method": "tab.close", "params": { "tabId": 2 } }

// Switch to tab by id or page index
{ "method": "tab.select", "params": { "tabId": 1 } }
{ "method": "tab.select", "params": { "pageIdx": 0 } }
```

**Response**: `{ "result": {} }`

### 5.4 tab.setControllable

Toggle whether a tab is controllable by the AI agent.

```json
{
  "method": "tab.setControllable",
  "params": { "tabId": 1, "controllable": true }
}
```

---

## 6. Keyboard Methods

### 6.1 keyboard.press

Press a key or key combination.

| Param | Type | Description |
|-------|------|-------------|
| `key` | string | Key name (e.g. `Enter`, `a`, `Control`) |
| `modifiers?` | string[] | Modifier keys (`Shift`, `Control`, `Alt`, `Meta`) |
| `tabId?` | number | Target tab |

```json
{
  "method": "keyboard.press",
  "params": { "key": "Enter", "tabId": 1 }
}
```

---

## 7. Script Methods

### 7.1 script.execute

Execute JavaScript in the page. **Requires user permission (E1 dialog).**

```json
{
  "method": "script.execute",
  "params": { "code": "document.title", "tabId": 1 }
}
```

**Response**:
```json
{
  "result": { "value": "Example Page Title" }
}
```

Script execution triggers the E1 permission dialog. User denial returns `BRP_PERMISSION_DENIED`.

---

## 8. History Methods

| Method | Description | Params |
|--------|-------------|--------|
| `history.search` | Search browser history | `text`, `startTime?`, `endTime?`, `maxResults?` |
| `history.delete` | Delete a URL from history | `url` |

History methods require the `history` optional permission (granted via extension options).

### 8.1 history.search

```json
{
  "method": "history.search",
  "params": { "text": "example", "maxResults": 10 }
}
```

**Response**:
```json
{
  "result": {
    "items": [
      {
        "id": "12345",
        "url": "https://example.com",
        "title": "Example Domain",
        "lastVisitTime": 1700000000000,
        "visitCount": 5
      }
    ],
    "count": 1
  }
}
```

If history permission is not granted, returns `BRP_HISTORY_PERMISSION_NOT_GRANTED` (-32004).

### 8.2 history.delete

Delete a URL from browser history.

```json
{
  "method": "history.delete",
  "params": { "url": "https://example.com" }
}
```

**Response**: `{ "result": { "deleted": "https://example.com" } }`

---

## 9. Error Codes

All errors are JSON-RPC 2.0 server errors (-32000 to -32099).

| Code | Error Code | Description |
|------|-----------|-------------|
| -32001 | `BRP_PERMISSION_DENIED` | User denied E1 permission dialog |
| -32002 | `BRP_USER_BLOCKED_DOMAIN` | Domain is in E2 blacklist |
| -32003 | `BRP_TAB_NOT_CONTROLLABLE` | Tab is not marked as controllable |
| -32004 | `BRP_HISTORY_PERMISSION_NOT_GRANTED` | History optional permission not granted |
| -32005 | `BRP_CAPABILITY_NOT_SUPPORTED` | Method not in negotiated capabilities |
| -32601 | `BRP_METHOD_NOT_FOUND` | Unknown method |
| -32000 | `BRP_INTERNAL_ERROR` | Internal extension error |

### 9.1 Error Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "User denied permission for script.execute",
    "data": {
      "errorCode": "BRP_PERMISSION_DENIED",
      "retriable": false
    }
  }
}
```

All error codes -32001 through -32004 are frozen (no breaking changes).

---

## 10. Permission Model

Requests go through a multi-layer permission check:

1. **Tab Check** (v0.5.2): Is the target tab marked as `controllable`?
   - Denied → `BRP_TAB_NOT_CONTROLLABLE` (-32003)
2. **Allowlist** (v0.5.1): Is the domain in the trusted allowlist?
   - Yes → skip E2 + E1, execute immediately
3. **Blacklist** (E2): Is the domain blocked?
   - Yes → `BRP_USER_BLOCKED_DOMAIN` (-32002)
4. **Permission Dialog** (E1): Prompt user for confirmation
   - Denied → `BRP_PERMISSION_DENIED` (-32001) + auto-demote tab
5. **Execute**: Perform the action

### 10.1 Tab-Scoped Methods

The following methods require the tab to be controllable:

`page.navigate`, `page.getInteractionTree`, `page.screenshot`,
`page.goBack`, `page.goForward`, `page.reload`, `page.waitForSelector`,
`element.click`, `element.type`, `element.fill`, `element.scroll`,
`element.hover`, `element.select`, `element.getAttribute`,
`keyboard.press`, `script.execute`,
`tab.close`, `tab.select`

Non-tab-scoped methods: `initialize`, `shutdown`, `tab.list`, `tab.open`, `tab.setControllable`, `history.search`, `history.delete`

---

## 12. Token Management (Bridge)

Token management methods are handled by the bridge directly (do not go through extension).
They require a master token for authorization.

| Method | Description | Params |
|--------|-------------|--------|
| `token.issue` | Issue a client token | `masterToken` |
| `token.revoke` | Revoke a client token | `masterToken`, `token` |
| `token.list` | List all client tokens | `masterToken` |

### 12.1 token.issue

Issue a new client token for extension authentication.

```json
{
  "method": "token.issue",
  "params": { "masterToken": "mt_abc123" }
}
```

**Response**:
```json
{
  "result": { "token": "ct_xyz789" }
}
```

Error: `BRP_MASTER_TOKEN_REQUIRED` if masterToken is invalid.

### 12.2 token.revoke

Revoke an issued client token.

```json
{
  "method": "token.revoke",
  "params": { "masterToken": "mt_abc123", "token": "ct_xyz789" }
}
```

**Response**:
```json
{
  "result": { "revoked": true }
}
```

### 12.3 token.list

List all active client tokens.

```json
{
  "method": "token.list",
  "params": { "masterToken": "mt_abc123" }
}
```

**Response**:
```json
{
  "result": { "tokens": ["ct_aaa", "ct_bbb"] }
}
```

---

## 13. Notification Events

Extension may send notifications to connected clients:

### 13.1 notification/bridge.authToken

Sent by the bridge on startup with authentication token:

```json
{
  "jsonrpc": "2.0",
  "method": "notification/bridge.authToken",
  "params": {
    "token": "<auth-token>",
    "tokenFile": "/path/to/token",
    "message": "Configure this token in the Extension Options page"
  }
}
```

---

## 14. API Freeze (v0.8.0)

As of v0.8.0:
- **Methods**: All 23 extension methods + 3 token management methods are stable. New methods may be added (additive only).
- **Error codes**: -32001 through -32004 are frozen. Code values, errorCode strings, and `retriable`/`recoveryHint` fields will not change.
- **Message format**: JSON-RPC 2.0 `{ jsonrpc, id, method/result/error }` structure is stable.
- **tab.list format**: Returns `{ tabs: [...], count }` with `controllable` field (since v0.5.2).
- **Selector format**: `{ type: "css"|"text"|"xpath", value: string }` is stable.
- **Precondition format**: `{ tagName?, textContains?, attributes? }` is stable.

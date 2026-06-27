# RFC 0001: Browser Runtime Protocol Core Specification

- **RFC Number:** 0001
- **Title:** Browser Runtime Protocol Core Specification
- **Status:** Draft
- **Author:** BRP Working Group
- **Version:** 0.1.0
- **Requires:** RFC0000

---

# 1. Introduction

## 1.1 Purpose

This document defines the Browser Runtime Protocol (BRP), an implementation-independent protocol that standardizes communication between AI clients and active browser runtimes.

BRP specifies:

- protocol lifecycle
- runtime identity
- message semantics
- capability negotiation
- event synchronization
- interaction state
- error handling

This specification intentionally excludes browser implementation details.

Unless otherwise stated, all requirements in this document are normative.

---

## 1.2 Design Philosophy

BRP follows several fundamental principles.

### Runtime-oriented

Browsers are treated as interactive runtimes rather than debugging targets.

The protocol interacts with existing user sessions instead of creating isolated automation environments.

---

### Event-driven

BRP is fundamentally asynchronous.

Runtime state changes are communicated through notifications rather than polling.

---

### Transport-independent

Protocol semantics are independent of the underlying transport.

Implementations MAY use:

- Native Messaging
- stdio
- WebSocket
- Named Pipe
- Unix Domain Socket
- future transports

without affecting protocol behavior.

---

### Browser-neutral

BRP does not depend on:

- Chrome DevTools Protocol
- Firefox Remote Debugging Protocol
- WebDriver
- Playwright internals
- Puppeteer internals

Browser-specific behavior MUST be implemented by adapters.

---

### AI-first

BRP exposes interaction-oriented runtime information instead of browser implementation details.

The protocol is optimized for autonomous reasoning rather than developer debugging.

---

# 2. Terminology

The following terms are used throughout this specification.

---

## BRP

Browser Runtime Protocol.

The protocol specified by this document.

---

## Client

An application implementing the BRP client role.

Examples include:

- AI Agents
- IDEs
- Automation frameworks
- SDKs

---

## Bridge

The protocol server responsible for translating BRP messages into browser-specific operations.

A Bridge manages:

- sessions
- browser discovery
- permissions
- transports
- adapters

---

## Extension

A browser extension implementing the browser-side runtime component.

The Extension performs operations such as:

- DOM interaction
- event observation
- accessibility extraction
- Interaction Tree generation

---

## Runtime

A browser runtime instance.

Examples:

- Firefox Stable
- Firefox Nightly
- Zen Browser
- Floorp

A Runtime may contain multiple workspaces.

---

## Workspace

A logical collection of browser windows.

Not every browser supports workspaces.

Browsers without workspace support MUST expose a default workspace.

---

## Window

A browser window.

Each Window contains one or more tabs.

---

## Tab

A browser tab.

Tabs contain one active top-level document.

---

## Frame

A document execution context.

Frames include:

- top-level document
- iframe
- embedded browsing context

Every frame owns an independent interaction state.

---

## Interaction Tree (ITree)

A structured representation of the interactive state of a document.

Interaction Tree replaces raw HTML as the primary runtime representation exposed to AI clients.

---

## Selector

An abstract object describing how a runtime object is identified.

Selectors are independent of browser engines.

---

# 3. Architecture

BRP defines three protocol participants.

```text
+---------------------+
|      Client         |
|  (Agent / IDE)      |
+----------+----------+
           |
           |
      JSON-RPC 2.0
           |
+----------v----------+
|       Bridge        |
| Session Management  |
| Capability Negotiation
| Security            |
| Adapter Routing     |
+----------+----------+
           |
     Browser Adapter
           |
+----------v----------+
|     Extension       |
| DOM Access          |
| Events              |
| ITree               |
| Browser Runtime     |
+---------------------+
```

---

## 3.1 Responsibilities

### Client

A Client:

- sends requests
- receives responses
- receives notifications
- maintains local runtime state

A Client MUST NOT assume browser-specific behavior.

---

### Bridge

The Bridge:

- validates protocol messages
- authenticates sessions
- negotiates capabilities
- routes requests
- preserves ordering
- translates protocol messages

The Bridge is the protocol authority.

---

### Extension

The Extension performs browser-local operations.

Typical responsibilities include:

- locating elements
- observing DOM mutations
- extracting accessibility information
- dispatching browser events

The Extension MUST NOT expose browser internals directly.

---

# 4. Protocol Layers

BRP is organized into independent layers.

```text
Application
──────────────────────────

Core Actions

──────────────────────────

BRP Protocol

──────────────────────────

JSON-RPC 2.0

──────────────────────────

Transport

──────────────────────────

Operating System
```

Each layer has a clearly defined responsibility.

Implementations MAY replace one layer without affecting higher layers.

---

# 5. Conformance

A conforming implementation MUST implement one of the following roles.

## Client

A Client MUST:

- implement JSON-RPC 2.0
- complete initialization
- negotiate capabilities
- preserve message ordering
- ignore unknown fields

---

## Bridge

A Bridge MUST:

- validate incoming messages
- authenticate sessions
- negotiate protocol versions
- enforce permissions
- preserve sequencing
- expose runtime capabilities

---

## Extension

An Extension MUST:

- expose runtime events
- execute browser actions
- generate Interaction Trees
- enforce browser security boundaries

---

# 6. Normative Language

The keywords:

- MUST
- MUST NOT
- REQUIRED
- SHALL
- SHALL NOT
- SHOULD
- SHOULD NOT
- MAY

are to be interpreted as described by RFC 2119 and RFC 8174.

---

# 7. Relationship to Other Specifications

RFC0001 defines only the protocol foundation.

Subsequent RFCs extend this specification.

| RFC | Purpose |
|------|---------|
| RFC0002 | Core Actions |
| RFC0003 | Interaction Tree |
| RFC0004 | Security Model |
| RFC0005 | Transport Layer |

Unless explicitly stated otherwise, later RFCs MUST remain compatible with RFC0001.

---

# 8. Notational Conventions

JSON examples are informative unless explicitly identified as normative.

ABNF grammars follow RFC 5234.

Message schemas reference the corresponding files under:

```text
schemas/
```

Implementation examples under:

```text
examples/
```

are informative only and do not define protocol behavior.
# 9. Message Model

## 9.1 Overview

BRP adopts JSON-RPC 2.0 as its application message protocol.

Unless otherwise specified by future RFCs, all BRP messages MUST conform to the JSON-RPC 2.0 specification.

BRP defines three message categories:

- Request
- Response
- Notification

BRP does not redefine JSON-RPC semantics.

Instead, it defines browser runtime semantics carried by JSON-RPC messages.

---

## 9.2 Request

A Request represents a client-initiated operation.

Every Request MUST contain:

- jsonrpc
- id
- method

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "page.navigate",
  "params": {
    "uri": "https://example.com"
  }
}
```

The Bridge MUST eventually return either:

- a Response
- an Error Response

---

## 9.3 Response

Responses correspond to exactly one Request.

A successful Response MUST contain:

- jsonrpc
- id
- result

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "result": {}
}
```

---

## 9.4 Error Response

Failed Requests MUST return a JSON-RPC Error.

BRP extends JSON-RPC errors through the `data` object.

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "error": {
    "code": -32001,
    "message": "Target not found",
    "data": {
      "errorCode": "BRP_TARGET_NOT_FOUND",
      "retriable": false
    }
  }
}
```

---

## 9.5 Notification

Notifications represent asynchronous runtime events.

Notifications MUST NOT contain an `id`.

Example:

```json
{
  "jsonrpc": "2.0",
  "method": "notification/navigationCompleted",
  "params": {}
}
```

Unless otherwise defined, Notifications are sent from Bridge to Client.

Protocol-level notifications beginning with `$/' MAY be bidirectional.

Examples include:

```
$/cancelRequest
$/progress
$/logTrace
```

---

# 10. Session Lifecycle

## 10.1 Overview

Every BRP connection owns exactly one Session.

A Session defines:

- negotiated protocol version
- capabilities
- authentication state
- runtime mappings
- sequence counter

Unless future RFCs specify otherwise, BRP assumes one Client per Session.

---

## 10.2 Session States

```
Disconnected

        │

        ▼

Connecting

        │

        ▼

Authenticating

        │

        ▼

Ready

        │

        ▼

Busy

        │

        ▼

Closing

        │

        ▼

Closed
```

---

## 10.3 State Definitions

### Disconnected

No transport connection exists.

No protocol messages may be exchanged.

---

### Connecting

The transport channel has been established.

Protocol initialization has not yet begun.

Only the `initialize` Request is permitted.

---

### Authenticating

The Bridge validates:

- protocol version
- client identity
- capability negotiation
- permission policy

No runtime operations are permitted during this state.

---

### Ready

The Session is fully initialized.

The Client MAY issue protocol Requests.

The Bridge MAY emit Notifications.

---

### Busy

Busy indicates the Bridge is executing one or more long-running operations.

Busy does NOT prevent concurrent Requests unless explicitly stated by the Action specification.

---

### Closing

The Bridge is releasing runtime resources.

Outstanding Requests SHOULD be completed whenever practical.

---

### Closed

The Session no longer exists.

Further Requests MUST return:

```
BRP_SESSION_CLOSED
```

---

## 10.4 Illegal Requests

Before initialization completes, the Bridge MUST reject every Request except:

- initialize
- $/cancelRequest

The Bridge MUST return:

```
BRP_SESSION_UNINITIALIZED
```

---

## 10.5 Shutdown

BRP follows a two-step shutdown sequence.

```
client.shutdown

↓

server prepares cleanup

↓

client.exit

↓

transport closes
```

The Bridge SHOULD finish outstanding operations before terminating.

---

# 11. Initialization

Initialization establishes a BRP Session.

Initialization performs:

- version negotiation
- capability negotiation
- session creation
- runtime discovery

Initialization MUST occur exactly once per Session.

---

## 11.1 Initialize Request

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "1.0.0",
    "clientInfo": {
      "name": "Example IDE",
      "version": "0.5"
    },
    "capabilities": {
      "features": [
        "interactionTree",
        "events"
      ]
    }
  }
}
```

---

## 11.2 Initialize Response

The Bridge MUST return the negotiated capabilities.

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "session-4dc53d",

    "protocolVersion": "1.0.0",

    "negotiatedVersion": "1.0.0",

    "serverInfo": {
      "name": "brp-bridge-gecko",
      "version": "0.3.1"
    },

    "capabilities": {

      "features": [
        "interactionTree",
        "events",
        "downloads"
      ],

      "actions": [
        "page.*",
        "tab.*",
        "element.click",
        "element.type"
      ],

      "treeDeltaSupported": true,

      "multiSession": false,

      "maxRequestSize": 10485760

    }
  }
}
```

The negotiated capabilities define the complete protocol contract for the Session.

Clients MUST NOT assume support for undeclared capabilities.

---

## 11.3 Version Negotiation

Protocol versions follow Semantic Versioning.

The negotiated version MUST satisfy both Client and Bridge.

If no compatible version exists, initialization MUST fail with:

```
BRP_SESSION_VERSION_MISMATCH
```

---

## 11.4 Capability Negotiation

Capabilities are additive.

Unknown capabilities MUST be ignored.

Unsupported capabilities MUST NOT cause initialization failure unless explicitly required by the Client.

Future RFCs MAY introduce additional capability namespaces.

---

# 12. Runtime Identity

## 12.1 Hierarchy

Every runtime object belongs to the following hierarchy.

```
Runtime

└── Workspace

      └── Window

             └── Tab

                    └── Frame

                           └── Node
```

Each level is independently addressable.

---

## 12.2 BRP URI

Runtime objects are identified by BRP URIs.

General form:

```
brp://runtime/workspace/window/tab/frame
```

Every URI uniquely identifies one browsing context.

Node identifiers are intentionally excluded.

Nodes belong to Interaction Trees rather than URI space.

---

## 12.3 URI Grammar

```
brp-uri =
    "brp://"
    runtime-id
    "/"
    workspace-id
    "/"
    window-id
    "/"
    tab-id
    [
        "/"
        frame-id
    ]
```

---

## 12.4 Reserved Runtime IDs

The following identifiers are reserved.

| Identifier | Meaning |
|------------|---------|
| active | Current active runtime |
| default | Default runtime |
| * | Wildcard |

Implementations MUST NOT redefine reserved identifiers.

---

## 12.5 Runtime Identifier Syntax

Runtime identifiers MUST match:

```
^[a-z][a-z0-9_-]{0,31}$
```

Identifiers are case-sensitive.

Future RFCs MAY define additional reserved namespaces.
# 13. Sequencing and Revision Model

## 13.1 Overview

BRP defines two independent monotonic counters:

- Session Sequence
- Frame Revision

The two counters serve different purposes and MUST NOT be interpreted interchangeably.

Sequence establishes message ordering.

Revision represents runtime state evolution.

---

## 13.2 Session Sequence

Each BRP Session owns a single global Sequence counter.

The Bridge MUST assign a unique Sequence number to every Notification emitted during the lifetime of the Session.

Properties:

| Property | Value |
|----------|-------|
| Scope | Per Session |
| Initial Value | 1 |
| Monotonic | Yes |
| Reset | Session Reinitialization |

Sequence numbers MUST increase strictly by one.

Sequence numbers MUST NOT be reused.

---

## 13.3 Frame Revision

Each browsing Frame owns an independent Revision counter.

Revision represents the logical version of that Frame's Interaction Tree.

Properties:

| Property | Value |
|----------|-------|
| Scope | Per Frame |
| Initial Value | 0 |
| Monotonic | Yes |
| Reset | Context Destruction |

Revisions belonging to different Frames are unrelated.

Clients MUST NOT compare Revisions across different Frames.

---

## 13.4 Revision Scope

Every Response or Notification carrying a Revision MUST identify the corresponding browsing context.

Example:

```json
{
  "params": {
    "uri": "brp://firefox/default/window-1/tab-3/frame-0",
    "revision": 42,
    "revisionScope": "frame"
  }
}
```

Future specifications MAY introduce additional revision scopes.

Unknown revision scopes MUST be ignored.

---

## 13.5 Context Destruction

Whenever a browsing context is destroyed, the Bridge MUST invalidate every identifier belonging to that context.

Examples include:

- navigation
- renderer restart
- frame removal
- process crash

Subsequent operations using obsolete identifiers MUST fail with:

```
BRP_CONTEXT_DESTROYED
```

A newly created browsing context begins with:

```
revision = 0
```

---

## 13.6 Ordering Guarantees

Within one Session:

- Notifications MUST preserve Sequence ordering.
- Responses MUST correspond to their Request IDs.
- Notifications MAY interleave with Responses.

Clients MUST use Sequence to reconstruct the global event order.

Revision MUST NOT be used for ordering.

---

# 14. Event Model

## 14.1 Overview

BRP is an event-driven protocol.

Browser state changes are propagated through Notifications.

Polling SHOULD be avoided whenever equivalent events are available.

---

## 14.2 Event Categories

Events are grouped into the following categories.

| Category | Description |
|----------|-------------|
| navigation | Document lifecycle |
| runtime | Session and context lifecycle |
| interaction | User-visible interaction changes |
| tree | Interaction Tree updates |
| download | Download lifecycle |
| console | Console output |
| network | Optional network events |

Future RFCs MAY define additional categories.

---

## 14.3 Common Event Metadata

Every Notification SHOULD include:

```json
{
  "sequence": 315,
  "timestamp": 1719234567,
  "uri": "brp://firefox/default/window-1/tab-2/frame-0"
}
```

Timestamp representation is implementation-defined.

Future RFCs MAY standardize timestamp formats.

---

## 14.4 Core Events

The Bridge SHOULD implement the following events.

| Event | Description |
|--------|-------------|
| navigationStarted | Navigation begins |
| navigationCompleted | Navigation finishes |
| domChanged | DOM mutation detected |
| interactionTreeChanged | ITree revision updated |
| tabCreated | New tab created |
| tabRemoved | Tab closed |
| frameAttached | Frame added |
| frameDetached | Frame removed |
| downloadStarted | Download begins |
| downloadFinished | Download completes |
| consoleMessage | Console output |

Support for individual events is negotiated through Capabilities.

---

## 14.5 Event Ordering

Notifications MUST be emitted according to Sequence order.

Clients MUST process Notifications in ascending Sequence order.

If a Notification is received out of order, the Client SHOULD delay processing until missing Sequences arrive.

Transport layers MAY guarantee ordered delivery.

---

## 14.6 Event Loss

If ordered delivery cannot be guaranteed, the Bridge SHOULD detect event loss whenever possible.

If event continuity cannot be restored, the Bridge SHOULD notify the Client.

Recommended Error:

```
BRP_EVENT_SEQUENCE_LOST
```

The Client SHOULD perform a full runtime resynchronization.

---

# 15. Recovery and Resynchronization

## 15.1 General Principle

RFC0001 does not require Event Replay.

Recovery is snapshot-based.

This avoids requiring Bridges to maintain unbounded event histories.

---

## 15.2 Connection Loss

After transport loss, Clients SHOULD:

1. Establish a new Session.
2. Execute Initialize.
3. Discard all cached runtime identifiers.
4. Discard all cached Node IDs.
5. Fetch a fresh Interaction Tree.

Clients MUST assume that previous runtime state is invalid.

---

## 15.3 Optional Event Replay

Future specifications MAY define an optional Replay capability.

Example capability:

```json
{
  "capabilities": {
    "eventReplay": true
  }
}
```

Replay behavior is intentionally outside the scope of RFC0001.

---

## 15.4 Interaction Tree Resynchronization

Whenever the Client determines that its local Interaction Tree is inconsistent, it MUST retrieve a complete snapshot.

Situations include:

- missing revisions
- unknown nodes
- failed delta application
- context recreation

Partial recovery is implementation-defined.

---

# 16. Interaction Tree Delta Consistency

## 16.1 Delta Messages

A Delta represents the transformation:

```
Revision N

↓

Revision N + 1
```

Each Delta MUST specify:

- fromRevision
- toRevision

---

## 16.2 Delta Validation

Suppose the Client currently stores Revision R.

Incoming Delta:

```
fromRevision = A

toRevision = B
```

Processing rules:

| Condition | Action |
|-----------|--------|
| A == R | Apply Delta |
| A > R | State gap detected → Request full snapshot |
| A < R | Ignore stale Delta |

Clients MUST NOT attempt to merge inconsistent histories.

---

## 16.3 Snapshot Synchronization

The Bridge MAY periodically emit complete snapshots instead of Deltas.

Snapshots SHOULD be preferred:

- after large DOM mutations
- after navigation
- after renderer recreation
- after synchronization failures

Snapshots replace the Client's entire local Interaction Tree.

---

## 16.4 Consistency Guarantee

After successfully applying either:

- a Snapshot
- a valid Delta sequence

the Client's Interaction Tree MUST represent the same logical state as the Bridge.

Implementations MAY differ internally, but externally observable behavior MUST remain equivalent.
# 17. Selector Model

## 17.1 Overview

Selectors identify runtime objects in a browser-independent manner.

BRP intentionally abstracts selector semantics from browser implementation details.

A conforming Bridge MUST support at least one selector type.

Support for additional selector types SHALL be negotiated through Capabilities.

---

## 17.2 Selector Object

Every selector MUST conform to the following structure.

```json
{
  "type": "role",
  "value": {
    "role": "button",
    "name": "Login"
  }
}
```

The `type` field determines how the `value` field is interpreted.

Unknown selector types MUST result in:

```
BRP_SELECTOR_UNSUPPORTED
```

---

## 17.3 Standard Selector Types

RFC0001 defines the following selector types.

| Type | Description |
|--------|-------------|
| nodeId | Stable Interaction Tree identifier |
| role | Accessibility role selector |
| text | Visible text selector |
| css | CSS selector |
| xpath | XPath selector |
| coordinate | Viewport coordinates |

Future RFCs MAY define additional selector types.

---

## 17.4 Selector Priority

When multiple selectors are provided, the Bridge SHOULD evaluate them in the specified order.

Example:

```json
{
  "selectors": [

    {
      "type": "nodeId",
      "value": "node_142"
    },

    {
      "type": "role",
      "value": {
        "role": "button",
        "name": "Login"
      }
    },

    {
      "type": "text",
      "value": "Login"
    }

  ]
}
```

The first successfully matched selector SHALL determine the target.

---

## 17.5 Matched Selector Feedback

The Bridge SHOULD report which selector successfully matched.

Example:

```json
{
  "result": {

    "matchedSelector": {

      "index": 1,

      "type": "role",

      "fallbackTriggered": true

    }

  }
}
```

Providing selector feedback enables Clients to improve future target selection strategies.

---

# 18. Error Model

## 18.1 Overview

BRP extends JSON-RPC error reporting with structured protocol-specific error codes.

Each BRP error SHALL include:

- errorCode
- retriable
- recoveryHint (optional)

---

## 18.2 Error Namespaces

BRP organizes errors by subsystem.

| Namespace | Purpose |
|------------|---------|
| BRP_TRANSPORT_* | Transport failures |
| BRP_SESSION_* | Session lifecycle |
| BRP_PERMISSION_* | Authorization |
| BRP_TARGET_* | Runtime objects |
| BRP_ELEMENT_* | Interaction failures |
| BRP_TIMEOUT_* | Timeout conditions |
| BRP_INTERNAL_* | Bridge implementation |

Future namespaces MUST begin with:

```
BRP_
```

---

## 18.3 Example Error

```json
{
  "error": {

    "code": -32002,

    "message": "Element is obscured",

    "data": {

      "errorCode": "BRP_ELEMENT_INTERSECTED",

      "retriable": true,

      "recoveryHint": "scroll_into_view",

      "details": {

        "occluderNodeId": "node_88"

      }

    }

  }
}
```

Clients SHOULD use `errorCode` rather than the human-readable message for recovery decisions.

---

## 18.4 Retry Semantics

Errors are classified as retriable or non-retriable.

Typical retriable errors include:

- temporary navigation
- loading delays
- occluded elements

Typical non-retriable errors include:

- permission denied
- unsupported capability
- malformed request

Implementations MAY provide additional recovery hints.

---

# 19. Security Model

## 19.1 Security Principles

BRP prioritizes user control over automation convenience.

Every implementation MUST ensure that protocol operations cannot silently exceed the user's intended permissions.

---

## 19.2 Permission Model

By default:

```
Deny All
```

No browsing context SHALL be remotely accessible unless explicitly authorized.

Authorization MAY be granted:

- per runtime
- per origin
- per session

Implementation-specific policies are permitted provided they remain at least as restrictive.

---

## 19.3 User Confirmation

Operations requiring elevated privileges SHOULD require explicit user confirmation.

Examples include:

- JavaScript execution
- file downloads
- clipboard access
- cookie export
- local filesystem access

Bridges SHOULD provide clear confirmation dialogs.

---

## 19.4 Audit Logging

Implementations SHOULD maintain an audit log for security-sensitive operations.

Typical entries include:

- timestamp
- runtime
- origin
- action
- requesting Client

Log format is implementation-defined.

---

# 20. Compatibility and Extensibility

## 20.1 Unknown Fields

Clients and Bridges MUST ignore unknown JSON fields unless explicitly specified otherwise.

This requirement preserves forward compatibility.

---

## 20.2 Vendor Extensions

Vendor-specific protocol methods MUST use vendor namespaces.

Examples:

```
vendor.mozilla.*

vendor.microsoft.*

vendor.openai.*

vendor.anthropic.*
```

Future RFCs MAY establish a centralized extension registry.

---

## 20.3 Experimental Methods

Experimental protocol methods SHOULD use:

```
brp.experimental.*
```

Experimental methods MUST NOT be relied upon for interoperability.

---

# 21. Protocol Registries

RFC0001 establishes the following reserved registries.

## Runtime IDs

```
active
default
*
```

---

## Notification Prefixes

```
notification/
$/ 
vendor.
```

---

## Capability Namespaces

```
core.*

tree.*

events.*

downloads.*

vision.*

vendor.*
```

Future RFCs MAY extend these registries.

---

# 22. References

## Normative References

- RFC 2119 — Key words for use in RFCs
- RFC 8174 — Ambiguity of Uppercase vs Lowercase Key Words
- RFC 5234 — Augmented BNF
- JSON-RPC 2.0 Specification
- Semantic Versioning 2.0.0

---

## Informative References

- Language Server Protocol
- Debug Adapter Protocol
- Chrome DevTools Protocol
- WebDriver BiDi

---

# Appendix A. Design Principles (Informative)

BRP intentionally differs from traditional browser automation protocols.

Rather than exposing browser implementation details, BRP exposes a stable runtime abstraction optimized for AI agents.

The protocol favors:

- event-driven synchronization
- accessibility-oriented interaction
- browser neutrality
- long-lived user sessions
- capability negotiation
- transport independence

These principles are expected to remain stable across future protocol versions.

---

# Changelog

| Version | Changes |
|----------|----------|
| 0.1.0 | Initial Draft-01 Core Specification |

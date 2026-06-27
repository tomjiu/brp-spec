# Contributing to Browser Runtime Protocol (BRP)

Thank you for your interest in contributing to the Browser Runtime Protocol (BRP).

BRP is developed as an open protocol specification rather than a browser implementation. Contributions should focus on improving protocol interoperability, consistency, extensibility, and long-term stability.

## Project Philosophy

BRP follows several fundamental principles:

- Protocol before implementation
- Browser neutrality
- Backward compatibility whenever practical
- Event-driven architecture
- Transport independence
- AI-oriented runtime abstraction

When proposing changes, contributors should prioritize protocol simplicity and implementation interoperability over implementation-specific optimizations.

## Repository Structure

```text
rfcs/           Protocol specifications
docs/           Design documents
schemas/        JSON Schemas
examples/       Example protocol exchanges
adapters/       Browser-specific mappings (future)
sdk/            Client SDKs (future)
```

## RFC Process

All protocol changes MUST be proposed through an RFC. Direct modifications to accepted specifications are discouraged.

The typical workflow is:

```text
Idea
  ↓
RFC Draft
  ↓
Community Review
  ↓
Revision
  ↓
Working Group Decision
  ↓
Accepted
  ↓
Implementation
```

## What Requires an RFC?

Major protocol changes require an RFC. Examples include:

- New protocol messages
- Lifecycle changes
- Capability negotiation
- Transport semantics
- Event model changes
- Error model changes
- Selector model extensions
- URI format changes
- Breaking compatibility

Minor editorial fixes generally do not require an RFC.

## RFC Numbering

RFC numbers are assigned sequentially. Example:

```text
0000-process.md
0001-core-protocol.md
0002-core-actions.md
0003-interaction-tree.md
0004-security-model.md
0005-transport.md
```

Numbers are never reused.

## Protocol Compatibility

BRP follows Semantic Versioning (`Major.Minor.Patch`).

General rules:

- Patch versions MUST NOT change protocol behavior.
- Minor versions MUST remain backward compatible.
- Major versions MAY introduce breaking changes.
- Unknown JSON fields MUST be ignored unless explicitly defined otherwise.

## Design Principles

When proposing protocol changes, contributors should evaluate proposals against the following questions.

### Is this browser-neutral?

The protocol should avoid depending on browser-specific behavior whenever possible.

### Does this improve interoperability?

A protocol feature should benefit multiple implementations instead of a single browser.

### Can this remain stable for years?

Protocol complexity is significantly harder to remove than to introduce. Contributors should prefer extensible abstractions over implementation details.

### Is this transport independent?

Protocol semantics should remain identical regardless of whether the transport uses Native Messaging, WebSocket, stdio, Unix Domain Socket, Named Pipe, or future transports.

### Does this belong in the protocol?

BRP specifies communication semantics, not browser implementation details. Implementation-specific optimizations belong inside adapters.

## Design Decision Records (ADR)

Architectural decisions are documented separately under `docs/adr/`. Examples include:

- Why BRP does not depend on CDP
- Why Interaction Tree replaces raw HTML
- Why BRP is event-driven
- Why JSON-RPC was selected
- Why runtime identity uses URIs

RFCs should reference ADRs instead of duplicating rationale.

## Pull Requests

Pull requests should:

- Address one logical change
- Include documentation updates when appropriate
- Preserve backward compatibility whenever possible
- Include protocol examples if introducing new behavior

Large protocol redesigns should begin as RFCs before implementation work.

## Code Style

Documentation should use:

- Clear, implementation-neutral language
- RFC 2119 terminology (MUST, SHOULD, MAY)
- JSON examples where appropriate
- Consistent terminology throughout the specification

Avoid browser-specific terminology unless discussing adapters.

## Review Guidelines

Review discussions should focus on:

- Protocol correctness
- Consistency
- Extensibility
- Compatibility
- Implementation feasibility

Avoid implementation preferences unless they affect interoperability.

## Governance

At the current stage, BRP is maintained by the project editor. Future governance may evolve toward a working group model as independent implementations emerge.

## License

Unless otherwise specified, all documentation and protocol specifications are licensed under the MIT License.

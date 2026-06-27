# rfcs/0000-process.md

# RFC 0000: RFC Process

- **RFC Number:** 0000
- **Title:** BRP RFC Process
- **Status:** Accepted
- **Author:** BRP Working Group
- **Version:** 1.0

---

# 1. Purpose

This document defines the process by which the Browser Runtime Protocol (BRP) evolves.

Unlike implementation repositories, BRP is a protocol specification. Every normative change to the protocol MUST be proposed, discussed, reviewed, and accepted through the RFC process described in this document.

RFC0000 governs all future RFCs.

---

# 2. Goals

The RFC process exists to:

- Provide a transparent decision-making process
- Preserve protocol consistency
- Encourage community review
- Prevent breaking changes without discussion
- Document architectural decisions
- Separate specification from implementation

---

# 3. Scope

This process applies to all normative protocol documents under the `rfcs/` directory.

Examples include:

- Core protocol
- Message definitions
- Capability negotiation
- Event model
- Error model
- Security model
- Transport specifications
- Selector model
- Interaction Tree
- Runtime identity

Editorial improvements that do not change protocol behavior MAY be submitted directly.

---

# 4. RFC Lifecycle

Every RFC progresses through the following states.

```text
Idea
 │
 ▼
Draft
 │
 ▼
Review
 │
 ▼
Accepted
 │
 ▼
Implemented
 │
 ▼
Deprecated (optional)
```

---

## 4.1 Idea

An idea represents an early proposal.

Ideas are intentionally informal and are not considered part of the protocol.

No compatibility guarantees exist.

---

## 4.2 Draft

Draft RFCs describe a concrete proposal.

Drafts SHOULD include:

- Motivation
- Goals
- Specification
- Examples
- Compatibility considerations

Draft RFCs are expected to change.

---

## 4.3 Review

Review indicates that the proposal is ready for technical discussion.

Review focuses on:

- correctness
- consistency
- interoperability
- extensibility
- implementation feasibility

Breaking changes SHOULD be identified during this stage.

---

## 4.4 Accepted

Accepted RFCs become part of the protocol specification.

Implementations SHOULD target Accepted RFCs.

Accepted RFCs remain normative until replaced.

---

## 4.5 Implemented

An Accepted RFC MAY be marked Implemented once at least one conforming implementation exists.

Implementation status does not imply interoperability with every browser.

---

## 4.6 Deprecated

Deprecated RFCs remain part of protocol history.

Implementations MAY continue supporting deprecated behavior for compatibility.

Deprecation SHOULD reference a replacement RFC.

---

## 4.7 Rejected

Rejected RFCs remain archived for historical reference.

Rejected RFCs MUST NOT become normative.

---

# 5. RFC Numbering

RFC numbers are permanent.

Numbers MUST NOT be reused.

Example:

```text
0000-process
0001-core-protocol
0002-core-actions
0003-interaction-tree
0004-security-model
```

Gaps are acceptable.

---

# 6. RFC Format

Every RFC SHOULD follow the standard template.

Required sections include:

- Summary
- Motivation
- Goals
- Non-Goals
- Terminology
- Specification
- Compatibility
- Security Considerations
- Examples

Additional sections MAY be added where appropriate.

---

# 7. Normative Language

Normative statements MUST follow RFC 2119 and RFC 8174.

The following keywords have special meaning:

- MUST
- MUST NOT
- REQUIRED
- SHALL
- SHALL NOT
- SHOULD
- SHOULD NOT
- RECOMMENDED
- MAY
- OPTIONAL

These keywords are interpreted only when written in uppercase.

---

# 8. Proposal Categories

RFCs generally fall into one of the following categories.

## Core

Defines protocol behavior.

Examples:

- lifecycle
- initialization
- requests
- notifications

---

## Extension

Introduces optional capabilities.

Examples:

- screenshots
- downloads
- accessibility

---

## Informational

Provides guidance without defining protocol behavior.

Examples:

- architecture
- implementation notes
- best practices

---

## Experimental

Documents features under evaluation.

Experimental RFCs MUST NOT be treated as stable protocol behavior.

---

# 9. Backward Compatibility

Backward compatibility is a primary design goal.

RFC authors SHOULD prefer additive changes.

Breaking changes MUST include:

- motivation
- migration strategy
- compatibility analysis

Whenever possible, new functionality SHOULD be introduced through capability negotiation instead of protocol replacement.

---

# 10. Versioning

BRP follows Semantic Versioning.

```
Major.Minor.Patch
```

General rules:

- Patch versions contain editorial improvements and clarifications.
- Minor versions introduce backward-compatible protocol features.
- Major versions MAY introduce incompatible protocol changes.

---

# 11. Review Criteria

Reviewers SHOULD evaluate proposals according to the following questions.

## Is the proposal browser-neutral?

The protocol SHOULD avoid depending on browser-specific APIs.

---

## Is the abstraction stable?

Protocol abstractions should survive implementation changes.

---

## Does it improve interoperability?

Features benefiting only one implementation SHOULD be reconsidered.

---

## Does it preserve compatibility?

Breaking changes require strong justification.

---

## Is the specification complete?

Normative behavior should be unambiguous.

Undefined behavior SHOULD be minimized.

---

# 12. Editorial Changes

Editorial changes include:

- spelling
- grammar
- formatting
- examples
- clarifications

Editorial changes do not require a new RFC.

---

# 13. Breaking Changes

Breaking changes include:

- removing messages
- changing message semantics
- changing lifecycle behavior
- incompatible JSON schemas
- incompatible capability negotiation

Breaking changes SHOULD target a future major version.

---

# 14. Relationship to ADRs

RFCs define protocol behavior.

ADRs explain architectural decisions.

RFCs SHOULD reference ADRs rather than repeating rationale.

Example:

```
RFC0001
    │
    └── references
            │
            ▼
ADR-0002
Why Interaction Tree
```

---

# 15. Relationship to Implementations

RFCs define expected behavior.

Implementations MAY differ internally.

Conformance is determined by externally observable protocol behavior rather than internal architecture.

---

# 16. Future Governance

BRP is currently maintained by the project editor.

As independent implementations emerge, governance MAY evolve into a working group responsible for:

- RFC acceptance
- version planning
- protocol compatibility
- extension registry
- long-term maintenance

The governance model itself SHOULD be specified through a future RFC.

---

# 17. References

- RFC 2119 — Key words for use in RFCs
- RFC 8174 — Ambiguity of Uppercase vs Lowercase Key Words
- JSON-RPC 2.0 Specification
- Semantic Versioning 2.0.0

---

# Changelog

| Version | Changes |
|----------|----------|
| 1.0 | Initial RFC process specification |
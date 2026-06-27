# RFC XXXX: Title

- **RFC Number:** XXXX
- **Title:** Short descriptive title
- **Status:** Draft
- **Author(s):**
- **Created:** YYYY-MM-DD
- **Updated:** YYYY-MM-DD
- **Requires:** (Optional)
- **Replaces:** (Optional)
- **Superseded By:** (Optional)

---

## Summary

Provide a concise overview of the proposal. This section should answer:

- What problem does this RFC solve?
- What changes are introduced?
- Why are these changes necessary?

Readers should understand the purpose of the RFC without reading the entire document.

---

## Motivation

Describe the background that motivates this proposal. Questions to consider:

- What limitation exists today?
- Why is the current behavior insufficient?
- Which implementations are affected?
- Why should this be standardized?

Avoid discussing implementation details in this section.

---

## Goals

List the intended objectives. Example:

- Standardize browser runtime behavior
- Improve interoperability
- Reduce protocol ambiguity
- Preserve backward compatibility

---

## Non-Goals

Explicitly state what this RFC does not attempt to solve. Example:

- Browser implementation details
- Performance optimizations
- AI planning strategies
- UI design

A clear Non-Goals section helps prevent scope creep.

---

## Terminology

Introduce any new terms required by this RFC. Every term should have a precise definition. Whenever possible, reuse terminology already defined by RFC0001.

---

## Specification

This section forms the normative part of the RFC. Use RFC 2119 terminology where appropriate (MUST, MUST NOT, SHOULD, SHOULD NOT, MAY). Normative statements should be unambiguous.

---

## Message Definitions

If the RFC introduces protocol messages, define them here. Include Request, Response, Notification, and Error behavior.

Example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "example.method",
  "params": {}
}
```

---

## State Machine

If applicable, define lifecycle behavior and valid transitions. Undefined transitions should be treated as protocol errors.

---

## Capability Negotiation

If new functionality is optional, describe capability names, feature flags, and negotiation rules. Capabilities should be additive whenever possible.

---

## Error Handling

Define error conditions, recovery behavior, and retry recommendations. Prefer extending existing error namespaces before creating new ones.

Example:

```
BRP_TARGET_NOT_FOUND
BRP_PERMISSION_DENIED
BRP_TIMEOUT
```

---

## Versioning

Describe compatibility implications. State whether the proposal requires a major version, is backward compatible, or can be negotiated through feature flags.

---

## Security Considerations

Every RFC should discuss security implications. If there are no known security implications, explicitly state so.

---

## Performance Considerations

Discuss expected performance impact. Performance claims should be implementation-neutral.

---

## Backward Compatibility

Explain how existing implementations should behave.

---

## Alternatives Considered

Document competing approaches and explain why the proposed solution was selected.

---

## Open Questions

List unresolved issues that should eventually be resolved before RFC acceptance.

---

## Examples

Provide realistic protocol examples with complete request/response pairs whenever practical.

---

## References

Reference related RFCs and external specifications (JSON-RPC 2.0, RFC 2119, RFC 8174, LSP, DAP).

---

## Appendix (Optional)

Supplementary information that is informative but not normative. Appendices MUST NOT introduce normative protocol requirements.

---

## Changelog

| Version | Changes |
|---------|---------|
| 0.1.0 | Initial draft |

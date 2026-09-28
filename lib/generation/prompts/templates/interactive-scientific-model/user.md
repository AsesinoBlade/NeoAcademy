Please perform scientific modeling for the following concept.

---

## Concept Information

**Subject**: {{subject}}
**Concept Name**: {{conceptName}}
**Concept Overview**: {{conceptOverview}}
**Key Points for Mastery**: {{keyPoints}}
**Design Idea**: {{designIdea}}

---

## Original Class Request

{{classRequirement}}

The Original Class Request expresses the user's explicit instructional intent.

If it explicitly requests formulas, equations, calculations, derivations,
mathematical relationships, quantitative modeling, or another specific
technical treatment, preserve that requirement whenever it is applicable
to this interactive.

---

## Source Evidence

{{sourceEvidence}}

For claims about a particular uploaded or reference source:

- Treat the Source Evidence above as authoritative.
- Preserve uncertainty, qualifiers, and stated limitations.
- Do not invent source-specific observations or properties.
- Do not strengthen an interpretation, hypothesis, possibility, or model inference into a fact.
- If the source says something cannot be determined, do not imply that it has been determined.
- General knowledge may be used for explanation, but keep it distinct from claims about the specific source.
## Task

1. List core mathematical formulas or quantitative laws only when they are genuinely relevant
2. Clarify the specific physical, causal, conceptual, or logical mechanisms
3. List constraints that any simulation or interaction must obey
4. List scientific or logical errors that must be strictly forbidden

Output JSON directly with the following structure:

```json
{
  "core_formulas": ["..."],
  "mechanism": ["..."],
  "constraints": ["..."],
  "forbidden_errors": ["..."]
}
```

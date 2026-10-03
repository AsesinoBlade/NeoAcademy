Questions: {{questions}}
Title: {{title}}
Key Points: {{keyPoints}}
Description: {{description}}
{{courseContext}}
{{agents}}

## Source Evidence

{{sourceEvidence}}

For claims about a particular uploaded or reference source:

- Treat the Source Evidence above as authoritative for what the supplied source itself establishes.
- Explicit user instructions or established course framing may independently establish a contextual premise. Do not require the uploaded pixels to re-prove that premise, and do not let a vision-model limitation negate it unless the supplied materials genuinely conflict.
- A contextual premise does not establish additional properties. For example, identifying the subject as a horse does not establish its breed, age, health, gait, temperament, lineage, provenance, or condition.
- Preserve uncertainty and qualifiers when they are relevant to a claim being made.
- Do not invent source-specific observations or properties.
- Do not strengthen an interpretation, hypothesis, possibility, or model inference into a fact.
- If Source Evidence contains a relevant limitation, respect it; do not gratuitously repeat unrelated limitations in learner-facing content.
- General knowledge may be used for explanation, but do not convert general associations into unsupported claims about the specific source.
- These are internal grounding instructions. Never mention "Source Evidence", "Source Evidence Policy", "Grounding Rule", "closed world", "closed-world rule", "grounding policy", or similar implementation terminology in learner-facing content or speech.
**Language Requirement**: Generated speech content must be in the same language as the key points above.

Output as a JSON array directly (no explanation, no code fences, 3-6 segments):
[{"type":"text","content":"Let's test your understanding"}]

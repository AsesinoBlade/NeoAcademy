# Generation Requirements

## Scene Information

- **Title**: {{title}}
- **Description**: {{description}}
- **Key Points**:
  {{keyPoints}}

{{teacherContext}}

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
- Treat grounding as silent quality control, not as curriculum. Unless this scene is explicitly supposed to teach evidence reasoning or uncertainty, keep learner-facing content centered on the requested subject and mention limitations only where a particular claim needs qualification.
## Available Resources

- **Available Images**: {{assignedImages}}
- **Canvas Size**: {{canvas_width}} × {{canvas_height}} px

## Output Requirements

Based on the scene information above, generate a complete Canvas/PPT component for one page.

**Language Requirement**: All generated text content must be in the same language as the title and description above.

**Must Follow**:

1. Output pure JSON directly, without any explanation or description
2. Do not wrap with ```json code blocks
3. Do not add any text before or after the JSON
4. Ensure the JSON format is correct and can be parsed directly
5. Use the provided image_id (e.g., `img_001`) for the `src` field of image elements
6. All TextElement `height` values must be selected from the quick reference table in the system prompt

**Output Structure Example**:
{"background":{"type":"solid","color":"#ffffff"},"elements":[{"id":"title_001","type":"text","left":60,"top":50,"width":880,"height":76,"content":"<p style=\"font-size:32px;\"><strong>Title Content</strong></p>","defaultFontName":"","defaultColor":"#333333"},{"id":"content_001","type":"text","left":60,"top":150,"width":880,"height":130,"content":"<p style=\"font-size:18px;\">• Point One</p><p style=\"font-size:18px;\">• Point Two</p><p style=\"font-size:18px;\">• Point Three</p>","defaultFontName":"","defaultColor":"#333333"}]}

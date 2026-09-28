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

- Treat the Source Evidence above as authoritative.
- Preserve uncertainty, qualifiers, and stated limitations.
- Do not invent source-specific observations or properties.
- Do not strengthen an interpretation, hypothesis, possibility, or model inference into a fact.
- If the source says something cannot be determined, do not imply that it has been determined.
- General knowledge may be used for explanation, but keep it distinct from claims about the specific source.
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

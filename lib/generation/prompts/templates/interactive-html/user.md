Create an interactive learning page for the following concept.

---

## Concept Information

**Concept Name**: {{conceptName}}
**Subject**: {{subject}}
**Concept Overview**: {{conceptOverview}}
**Key Points**: {{keyPoints}}

---

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
- Grounding is not automatically the interactive's teaching topic. Use observation-versus-inference, evidence classification, limitations, or uncertainty as learner-facing mechanics only when the user request or scene outline specifically calls for them. Otherwise keep the interaction focused on the requested subject while applying grounding silently.
## Scientific Constraints

The following constraints must be strictly obeyed in all JavaScript logic and visualizations:

{{scientificConstraints}}

---

## Interactive Design Idea

{{designIdea}}

---

## Available Source Images

{{availableSourceImages}}

When an assigned source image is needed:

- Use ONLY the exact `neo-source://...` reference shown above.
- Example: `<img src="neo-source://img_1" alt="Source image">`
- The same exact reference may be used in JavaScript, for example:
  `const src = "neo-source://img_1";`
- Do NOT use a bare logical ID such as `img_1` as an HTML URL.
- Do NOT invent a file path, HTTP URL, blob URL, base64 string, or replacement image.
- Do NOT recreate or redraw the supplied source image when the activity is intended to inspect that source.
- If the design calls for hotspots, annotations, zooming, overlays, or image inspection, place them over the actual assigned source image using its `neo-source://...` reference.
- Every clickable hotspot or selectable source-image region must have a persistent visible affordance before hover or selection. Use a clearly visible numbered circle, outlined region, pin, marker, translucent bounding box, or similarly obvious indicator.
- Do NOT rely on cursor changes, hover-only styling, transparent buttons, invisible hit areas, or undiscoverable click regions as the learner's only indication that a hotspot exists.
- A visible hotspot marker must remain legible against both light and dark image areas. Use sufficient contrast, outline, border, shadow, or backing shape as needed.
- The visible marker may change appearance on hover, focus, or selection, but it must already be visibly discoverable in its normal idle state.
- If no source image is assigned, do not fabricate or imply an authoritative source image.
- If a self-contained schematic is genuinely appropriate, it must be clearly schematic, visually recognizable, and must include visible numbered markers or clearly visible clickable regions on the diagram itself. Do not rely on invisible hover areas.

---

## Language

**Page language**: {{language}}

(All UI text, labels, instructions, and descriptions must be in this language)

---

## Requirements

1. Complete self-contained HTML5 document
2. Use Tailwind CSS via CDN for styling
3. Pure JavaScript for all interactivity
4. Math formulas in LaTeX format: `\(...\)` for inline, `\[...\]` for display
5. Do NOT include KaTeX - it will be injected automatically
6. All simulations must strictly follow the scientific constraints above
7. Focus on interactive visualization, minimal text
8. Reserve UI chrome such as headers, banners, controls, legends, and captions as non-drawable space.
9. Put diagrams/images/canvas/SVG and their annotation overlays inside a dedicated visualization container below any panel header.
10. Position annotation coordinates relative to that visualization container, never relative to a surrounding card that also contains a header.
11. Keep all annotation labels, markers, and leader lines visibly contained within the drawable visualization region.
12. Clamp or reposition labels when necessary so text cannot be clipped, hidden behind another panel, or covered by UI chrome.
13. Responsive resizing must preserve these safe areas and recalculate/reflow overlays as needed.
14. Before returning the page, verify that no annotation or overlay intersects any header, banner, toolbar, control panel, legend, or caption.
15. If the design requires an assigned source image, verify that the visualization actually contains an `<img>` element or equivalent JavaScript image load using the exact `neo-source://...` reference supplied above. Do not return an empty image viewer with controls but no source image.
16. If spatial regions are supplied for a source image, treat those coordinates as authoritative localization metadata. Do NOT guess hotspot positions from general knowledge or from where an object would normally be expected to appear.
17. Spatial-region x/y/width/height values are normalized to the complete source image. Place a point hotspot at the supplied centerX/centerY, or use the supplied rectangle when the interaction calls for a clickable region.
18. Position all source-image overlays relative to the actual rendered image bounds, not the surrounding card or panel. The overlay container must match the displayed image's position and aspect ratio so normalized coordinates remain aligned during resizing.
19. If the requested interactive feature has no supplied spatial region, do not invent a precise hotspot for it. Either omit that hotspot or present the information outside the image as non-spatial explanatory content.
20. All intended interactive controls must remain pointer-interactive. Do not apply `pointer-events: none` to buttons, hotspots, markers, sliders, toggles, draggable handles, selectable regions, quiz controls, or any parent layer whose children must receive clicks.
21. Decorative overlay layers may use `pointer-events: none`, but any interactive child inside such a layer must explicitly restore `pointer-events: auto`.
22. Before returning the HTML, verify that every element the learner is instructed to click can actually receive pointer input.
23. Before returning the HTML, verify that every clickable source-image hotspot is visibly discoverable in its idle state without requiring hover, cursor hunting, guessing, or prior knowledge of its location.

Return the complete HTML document directly.

## NEOACADEMY SANDBOX MODAL RULE

The interactive runs inside a sandboxed iframe.

NEVER use any browser modal API:
- `alert(...)`
- `window.alert(...)`
- `confirm(...)`
- `window.confirm(...)`
- `prompt(...)`
- `window.prompt(...)`

These APIs are blocked by the classroom sandbox and make an interaction appear broken.

All learner feedback MUST be rendered visibly inside the HTML itself. For example:
- update a feedback/detail panel,
- show or update a tooltip,
- highlight the selected item and display its value,
- change explanatory text,
- reveal an inline result card.

Every clickable control or chart item must produce an immediately visible in-page change. Do not rely on browser dialogs for feedback.
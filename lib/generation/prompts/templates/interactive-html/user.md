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

- Treat the Source Evidence above as authoritative.
- Preserve uncertainty, qualifiers, and stated limitations.
- Do not invent source-specific observations or properties.
- Do not strengthen an interpretation, hypothesis, possibility, or model inference into a fact.
- If the source says something cannot be determined, do not imply that it has been determined.
- General knowledge may be used for explanation, but keep it distinct from claims about the specific source.
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
- If no source image is assigned, do not fabricate one.

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

Return the complete HTML document directly.

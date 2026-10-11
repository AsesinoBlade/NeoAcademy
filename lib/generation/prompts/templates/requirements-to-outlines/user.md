Please generate scene outlines based on the following course requirements.

---

## User Requirements

{{requirement}}

---

{{userProfile}}

## Course Language

**Required language**: {{language}}

(If language is zh-CN, all content must be in Chinese; if en-US, all content must be in English)

---

## Reference Materials

### PDF Content Summary

{{pdfContent}}

### Available Images

{{availableImages}}

### Web Search Results

{{researchContext}}

{{teacherContext}}

---

## Output Requirements

Please automatically infer the following from user requirements:

- Course topic and core content
- Target audience and difficulty level
- Course duration (default 60-90 minutes deep dive if not specified; longer for "advanced"/"detailed" requests)
- Teaching style (default: rigorous, example-driven, hands-on)
- Visual style (minimal/colorful/professional/playful)

Then output a JSON array containing all scene outlines. Each scene must include:

```json
{
  "id": "scene_1",
  "type": "slide" or "quiz" or "interactive",
  "title": "Scene Title",
  "description": "Teaching purpose description",
  "keyPoints": ["Substantive point with real content", "Worked example with concrete values/code", "Pitfall", "..."],
  "teachingNotes": "80-250 word teaching brief: exact rule, worked example(s), pitfalls, exercise + solution",
  "order": 1
}
```

**Depth check before you output**: For each scene, could someone learn the actual technique/feature from its keyPoints + teachingNotes alone? If a keyPoint only *names* a topic ("Generics", "The ×11 trick"), rewrite it to *teach* it. If the course only lists techniques without worked examples and learner exercises, add scenes.

### Special Notes

1. **quiz scenes must include quizConfig**:
   ```json
   "quizConfig": {
     "questionCount": 4,
     "difficulty": "easy" | "medium" | "hard",
     "questionTypes": ["single", "multiple"]
   }
   ```
2. **If images are available**, add `suggestedImageIds` to relevant slide scenes
3. **Interactive scenes**: If learner manipulation materially improves understanding, use `"type": "interactive"` with an `interactiveConfig` object containing `conceptName`, `conceptOverview`, `designIdea`, and `subject`. This includes simulation and visualization, but also annotation, inspection, comparison, classification, evidence evaluation, and exploration of supplied images or other source material. Do not add an interactive merely for variety. Limit to 1-2 per course. If an interactive uses one or more supplied source images, also include those image IDs in the scene's `suggestedImageIds` array exactly as you would for a slide. For example, an interactive whose design uses `img_1` must include `"suggestedImageIds": ["img_1"]`.
4. **Scene count**: Size by content — typically 20-40 scenes of 3-6 minutes each for a deep dive. Each scene teaches one narrow idea in depth.
5. **Quiz placement**: Insert an applied quiz (3-5 questions that require using the techniques) every 3-6 slides
6. **Language**: Strictly output all content in the specified course language
7. **If no suitable supplied source images exist** for a slide scene that would benefit from visuals, add `mediaGenerations` array with image generation prompts. If the lesson is analyzing a particular supplied image, prefer that source image and do not generate a replacement or look-alike of the same subject unless the user explicitly requests one. Generated media may supplement the source only when it serves a genuinely different explanatory purpose. Write prompts in English. Use `elementId` format like "gen_img_1", "gen_img_2" — IDs must be **globally unique across all scenes** (do NOT restart numbering per scene). To reuse a generated image in a different scene, reference the same elementId without re-declaring it in mediaGenerations. Each generated image should be visually distinct — avoid near-identical media across slides.
8. **If web search results are provided**, reference specific findings and sources in scene descriptions and keyPoints. The search results provide up-to-date information — incorporate it to make the course content current and accurate.

{{mediaGenerationPolicy}}

Please output JSON array directly without additional explanatory text.

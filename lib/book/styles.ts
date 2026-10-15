/**
 * Book styles: how long, how deep and in what voice a book is written.
 * One profile drives the outline (size, structure), the continuation check
 * (minimum chapters) and every section writer (tone, length, endings).
 */
export type BookStyle = 'quick' | 'beginner' | 'advanced';

export interface BookStyleProfile {
  id: BookStyle;
  /** Shown in the picker. */
  label: string;
  /** One line under the label in the picker. */
  hint: string;
  chapters: [number, number];
  sectionsPerChapter: [number, number];
  /** Words per regular section / per final "summary" section. */
  sectionWords: string;
  summaryWords: string;
  /** Rough page count, for the outline header. */
  pages: string;
  /** Fewer chapters than this means the model stopped early. */
  minChapters: number;
  /** Name of each chapter's final section. */
  closingSection: string;
  /** Extra planning instructions for the outline. */
  outlineGuidance: string;
  /** Extra writing instructions for every section. */
  writerGuidance: string;
}

export const BOOK_STYLES: Record<BookStyle, BookStyleProfile> = {
  quick: {
    id: 'quick',
    label: 'Quick how-to',
    hint: 'Short and practical — get it working fast',
    chapters: [3, 6],
    sectionsPerChapter: [3, 5],
    sectionWords: '600-900',
    summaryWords: '300-500',
    pages: '40–80',
    minChapters: 3,
    closingSection: 'Recap and checklist',
    outlineGuidance: `This is a QUICK HOW-TO book: the shortest reliable path from zero to a working result.
- Chapter 1 is a quick start: the reader achieves a first real result within the first few pages.
- Every section is a concrete task ("Install X", "Build your first Y"), in the order the reader will do them.
- Include only the theory needed to avoid mistakes; skip history, alternatives and edge cases unless the user asks.
- The last chapter is "Where to go next": common next steps and the most frequent problems with their fixes.`,
    writerGuidance: `Style: QUICK HOW-TO.
- Be concise and practical. Lead with what the reader will achieve, then numbered steps with the exact commands, values and settings, then what they should see.
- Explain "why" in at most a sentence or two, only where it prevents a mistake.
- Use short paragraphs, numbered steps and one complete example; no long digressions.
- The closing section of each chapter is a brief recap plus a checklist the reader can tick off, and one small "Try it" task — no graded exercise sets.`,
  },
  beginner: {
    id: 'beginner',
    label: "Beginner's guide",
    hint: 'Friendly, step by step — assumes nothing',
    chapters: [8, 14],
    sectionsPerChapter: [4, 7],
    sectionWords: '1,000-1,500',
    summaryWords: '600-900',
    pages: '150–250',
    minChapters: 6,
    closingSection: 'Summary and practice',
    outlineGuidance: `This is a BEGINNER'S GUIDE that holds the reader's hand: assume no prior knowledge of the subject at all.
- Start with what the subject is, why it matters, and what the reader needs before starting.
- Introduce one idea at a time in very small steps; never use a term before it has been explained.
- Plan frequent small wins: each chapter ends with something the reader has done themselves.
- Include a chapter on common mistakes and how to recover from them, and finish with a gentle path to further learning.`,
    writerGuidance: `Style: BEGINNER'S GUIDE — friendly, patient, encouraging.
- Write in a warm, conversational second person ("you"), with plain words and short paragraphs. Light humour is fine; condescension is not.
- Define every technical term the first time it appears, in plain language, ideally with an everyday analogy.
- Break every procedure into small numbered steps that say exactly what to type, click or choose — and after key steps, "What you should see now:".
- Use these callouts where they help (Markdown blockquotes): "> **Tip:** ...", "> **Remember:** ...", "> **Warning:** ..." (and "> **Technical stuff:** ..." for optional deeper detail the reader may skip).
- Reassure the reader at the points where beginners usually get stuck, and say how to recover.
- The closing section of each chapter summarises in plain words and gives a few gentle practice tasks with complete, explained solutions.`,
  },
  advanced: {
    id: 'advanced',
    label: 'In-depth advanced',
    hint: 'Detailed deep dive with worked examples',
    chapters: [14, 22],
    sectionsPerChapter: [5, 9],
    sectionWords: '1,600-2,300',
    summaryWords: '900-1,400',
    pages: '300–500',
    minChapters: 8,
    closingSection: 'Summary and exercises',
    outlineGuidance: `This is an IN-DEPTH ADVANCED book: a thorough expert treatment with worked examples, real-world detail and graded exercises.`,
    writerGuidance: `Style: IN-DEPTH ADVANCED — expert depth, precise terminology, thorough worked examples.`,
  },
};

export function getBookStyle(style: string | undefined | null): BookStyleProfile {
  return BOOK_STYLES[(style as BookStyle) in BOOK_STYLES ? (style as BookStyle) : 'advanced'];
}

/** Size line for the outline prompt. */
export function sizeGuidance(profile: BookStyleProfile): string {
  return (
    `typically **${profile.chapters[0]}–${profile.chapters[1]} chapters**, each with **${profile.sectionsPerChapter[0]}–${profile.sectionsPerChapter[1]} sections**. ` +
    `Each section becomes roughly ${profile.sectionWords} words, so this yields a ${profile.pages} page book. ` +
    'Go larger only if the user asks for more; smaller only if the user asks for a shorter book.'
  );
}

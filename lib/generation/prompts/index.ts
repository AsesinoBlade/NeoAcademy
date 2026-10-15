/**
 * Prompt System - Simplified prompt management
 *
 * Features:
 * - File-based prompt storage in templates/
 * - Snippet composition via {{snippet:name}} syntax
 * - Variable interpolation via {{variable}} syntax
 */

// Types
export type { PromptId, SnippetId, LoadedPrompt } from './types';

// Loader functions
export {
  loadPrompt,
  loadSnippet,
  buildPrompt,
  interpolateVariables,
  clearPromptCache,
} from './loader';

// Prompt IDs constant
export const PROMPT_IDS = {
  REQUIREMENTS_TO_OUTLINES: 'requirements-to-outlines',
  SLIDE_CONTENT: 'slide-content',
  QUIZ_CONTENT: 'quiz-content',
  SLIDE_ACTIONS: 'slide-actions',
  QUIZ_ACTIONS: 'quiz-actions',
  INTERACTIVE_SCIENTIFIC_MODEL: 'interactive-scientific-model',
  INTERACTIVE_HTML: 'interactive-html',
  INTERACTIVE_ACTIONS: 'interactive-actions',
  PBL_ACTIONS: 'pbl-actions',
  REQUIREMENTS_TO_BOOK_OUTLINE: 'requirements-to-book-outline',
  BOOK_SECTION: 'book-section',
  BOOK_PLAN: 'book-plan',
  BOOK_CLAIMS: 'book-claims',
  BOOK_REVIEW: 'book-review',
  BOOK_FIX_BUILD: 'book-fix-build',
  BOOK_MATH: 'book-math',
  BOOK_PREMISES: 'book-premises',
  BOOK_PRINCIPLES: 'book-principles',
  BOOK_CONSISTENCY: 'book-consistency',
  BOOK_VERIFICATION_PLAN: 'book-verification-plan',
  BOOK_CROSS_CHECK: 'book-cross-check',
  BOOK_CROSS_COMPARE: 'book-cross-compare',
} as const;

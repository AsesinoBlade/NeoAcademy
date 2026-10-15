/**
 * Simplified prompt system type definitions
 */

/**
 * Prompt template identifier
 */
export type PromptId =
  | 'requirements-to-outlines'
  | 'slide-content'
  | 'quiz-content'
  | 'slide-actions'
  | 'quiz-actions'
  | 'interactive-scientific-model'
  | 'interactive-html'
  | 'interactive-actions'
  | 'pbl-actions'
  | 'requirements-to-book-outline'
  | 'book-section'
  | 'book-plan'
  | 'book-claims'
  | 'book-review'
  | 'book-fix-build'
  | 'book-math'
  | 'book-premises'
  | 'book-principles'
  | 'book-consistency'
  | 'book-verification-plan'
  | 'book-cross-check'
  | 'book-cross-compare';

/**
 * Snippet identifier
 */
export type SnippetId =
  | 'json-output-rules'
  | 'element-types'
  | 'action-types'
  | 'teaching-depth';

/**
 * Loaded prompt template
 */
export interface LoadedPrompt {
  id: PromptId;
  systemPrompt: string;
  userPromptTemplate: string;
}

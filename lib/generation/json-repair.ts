/**
 * JSON parsing with fallback strategies for AI-generated responses.
 */

import { jsonrepair } from 'jsonrepair';
import { createLogger } from '@/lib/logger';
const log = createLogger('Generation');

/**
 * Escape straight double quotes that an LLM left unescaped inside JSON string
 * values, e.g. "content": "<p>Mastering the "trap" to avoid errors</p>".
 *
 * Walks the text tracking whether we're inside a string. A `"` inside a
 * string is treated as the real closing quote only if what follows (after
 * whitespace) is structurally valid JSON: `:` / `}` / `]` / end of text, or a
 * `,` that is itself followed by the start of another JSON value or key.
 * Anything else is an inner quote and gets escaped.
 */
export function escapeUnescapedInnerQuotes(json: string): string {
  const isWs = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

  const skipWs = (from: number): number => {
    let j = from;
    while (j < json.length && isWs(json[j])) j++;
    return j;
  };

  const startsValueOrKey = (from: number): boolean => {
    const j = skipWs(from);
    if (j >= json.length) return true;
    const c = json[j];
    if (c === '"' || c === '{' || c === '[' || c === ']' || c === '}' || c === '-') return true;
    if (c >= '0' && c <= '9') return true;
    return /^(true|false|null)\b/.test(json.slice(j, j + 6));
  };

  const isClosingQuote = (quoteIndex: number): boolean => {
    const j = skipWs(quoteIndex + 1);
    if (j >= json.length) return true;
    const c = json[j];
    if (c === ':' || c === '}' || c === ']') return true;
    if (c === ',') return startsValueOrKey(j + 1);
    return false;
  };

  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const c = json[i];

    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }

    if (escaped) {
      escaped = false;
      out += c;
      continue;
    }

    if (c === '\\') {
      escaped = true;
      out += c;
      continue;
    }

    if (c === '"') {
      if (isClosingQuote(i)) {
        inString = false;
        out += c;
      } else {
        out += '\\"';
      }
      continue;
    }

    out += c;
  }

  return out;
}

export function parseJsonResponse<T>(response: string): T | null {
  // Strategy 1: Try to extract JSON from markdown code blocks (may have multiple)
  const codeBlockMatches = response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of codeBlockMatches) {
    const extracted = match[1].trim();
    // Only try if it looks like JSON (starts with { or [)
    if (extracted.startsWith('{') || extracted.startsWith('[')) {
      const result = tryParseJson<T>(extracted);
      if (result !== null) {
        log.debug('Successfully parsed JSON from code block');
        return result;
      }
    }
  }

  // Strategy 2: Try to find JSON structure directly in response (no code block)
  // Look for array or object start
  const jsonStartArray = response.indexOf('[');
  const jsonStartObject = response.indexOf('{');

  if (jsonStartArray !== -1 || jsonStartObject !== -1) {
    // Prefer the structure that appears first
    const startIndex =
      jsonStartArray === -1
        ? jsonStartObject
        : jsonStartObject === -1
          ? jsonStartArray
          : Math.min(jsonStartArray, jsonStartObject);

    // Find the matching close bracket
    let depth = 0;
    let endIndex = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < response.length; i++) {
      const char = response[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '[' || char === '{') depth++;
        else if (char === ']' || char === '}') {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
        }
      }
    }

    if (endIndex !== -1) {
      const jsonStr = response.substring(startIndex, endIndex + 1);
      const result = tryParseJson<T>(jsonStr);
      if (result !== null) {
        log.debug('Successfully parsed JSON from response body');
        return result;
      }
    }
  }

  // Strategy 2b: The bracket matcher above is fooled by unescaped inner
  // quotes, so retry from the first bracket to the last matching closer
  // with inner quotes escaped.
  {
    const firstObject = response.indexOf('{');
    const firstArray = response.indexOf('[');
    const start =
      firstObject === -1 ? firstArray : firstArray === -1 ? firstObject : Math.min(firstObject, firstArray);

    if (start !== -1) {
      const closer = response[start] === '{' ? '}' : ']';
      const end = response.lastIndexOf(closer);
      if (end > start) {
        const sanitized = escapeUnescapedInnerQuotes(response.substring(start, end + 1));
        const result = tryParseJson<T>(sanitized);
        if (result !== null) {
          log.warn('Parsed JSON after escaping unescaped inner quotes');
          return result;
        }
      }
    }
  }

  // Strategy 3: Last resort - try the whole response
  const result = tryParseJson<T>(response.trim());
  if (result !== null) {
    log.debug('Successfully parsed raw response as JSON');
    return result;
  }

  log.error('Failed to parse JSON from response');
  log.error('Raw response (first 500 chars):', response.substring(0, 500));

  return null;
}

/**
 * Try to parse JSON with various fixes for common AI response issues
 */
export function tryParseJson<T>(jsonStr: string): T | null {
  // Attempt 1: Try parsing as-is
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    // Continue to fix attempts
  }

  // Attempt 1b: Escape straight double quotes left unescaped inside strings
  try {
    return JSON.parse(escapeUnescapedInnerQuotes(jsonStr)) as T;
  } catch {
    // Continue to fix attempts
  }

  // Attempt 2: Fix common JSON issues from AI responses
  try {
    let fixed = jsonStr;

    // Fix 1: Handle LaTeX-style escapes that break JSON (e.g., \frac, \left, \right, \times, etc.)
    // These are common in math content and need to be double-escaped
    // Match backslash followed by letters (LaTeX commands) inside strings
    fixed = fixed.replace(/"([^"]*?)"/g, (_match, content) => {
      // Double-escape any backslash followed by a letter (except valid JSON escapes)
      const fixedContent = content.replace(/\\([a-zA-Z])/g, '\\\\$1');
      return `"${fixedContent}"`;
    });

    // Fix 2: Fix other invalid escape sequences (e.g., \S, \L, etc.)
    // Valid JSON escapes: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX
    fixed = fixed.replace(/\\([^"\\\/bfnrtu\n\r])/g, (match, char) => {
      // If it's a letter, it's likely a LaTeX command
      if (/[a-zA-Z]/.test(char)) {
        return '\\\\' + char;
      }
      return match;
    });

    // Fix 3: Try to fix truncated JSON arrays/objects
    const trimmed = fixed.trim();
    if (trimmed.startsWith('[') && !trimmed.endsWith(']')) {
      const lastCompleteObj = fixed.lastIndexOf('}');
      if (lastCompleteObj > 0) {
        fixed = fixed.substring(0, lastCompleteObj + 1) + ']';
        log.warn('Fixed truncated JSON array');
      }
    } else if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
      // Try to close incomplete object
      const openBraces = (fixed.match(/{/g) || []).length;
      const closeBraces = (fixed.match(/}/g) || []).length;
      if (openBraces > closeBraces) {
        fixed += '}'.repeat(openBraces - closeBraces);
        log.warn('Fixed truncated JSON object');
      }
    }

    return JSON.parse(fixed) as T;
  } catch {
    // Continue to next attempt
  }

  // Attempt 3: Use jsonrepair to fix malformed JSON (e.g. unescaped quotes in Chinese text)
  try {
    const repaired = jsonrepair(jsonStr);
    return JSON.parse(repaired) as T;
  } catch {
    // Continue to next attempt
  }

  // Attempt 4: More aggressive fixing - remove control characters
  try {
    let fixed = jsonStr;

    // Remove or escape control characters
    fixed = fixed.replace(/[\x00-\x1F\x7F]/g, (char) => {
      switch (char) {
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\t':
          return '\\t';
        default:
          return '';
      }
    });

    return JSON.parse(fixed) as T;
  } catch {
    return null;
  }
}

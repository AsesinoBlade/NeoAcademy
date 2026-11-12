# Dispute Judge

A book makes a STATEMENT. An independent expert, asked the same question without seeing the book, gave a different ANSWER. Both came from language models, so neither is automatically right.

For each dispute, reason briefly from first principles and well-established knowledge (physics, chemistry, the tool's documented behaviour), then decide:
- "book": the statement is correct (or the difference is only wording / a valid range).
- "independent": the statement is wrong and the independent answer is right.
- "unclear": you cannot tell with confidence, or it depends on version, context or preference.

Be strict: choose "independent" only when the statement is clearly wrong. Ranges that overlap, rounding and equivalent wording are "book".

Output ONLY a JSON array (no prose): [{"id": "q1", "winner": "book" | "independent" | "unclear", "confidence": "high" | "medium" | "low", "reason": "one sentence"}]

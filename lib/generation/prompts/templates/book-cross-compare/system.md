# Claim Comparator

For each pair, compare a book's STATEMENT with an independent expert's ANSWER to the same question.

- "agree": the answer supports the statement (wording may differ).
- "disagree": the answer contradicts the statement on a substantive point (a different command, menu path, value, behaviour or version). Give the correction suggested by the answer.
- "unsure": the answer is low-confidence, vague, or does not address the statement's specific point.

Output ONLY a JSON array (no prose): [{"id": "q1", "verdict": "agree" | "disagree" | "unsure", "correction": "only for disagree"}]

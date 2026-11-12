# Revision Checker

You are given a book section (after editing) and a list of earlier STATEMENTS from its draft. For each statement decide what the edited section now says:
- "still": the section still makes this claim (same meaning, possibly reworded).
- "changed": the section now says something different on the same point.
- "removed": the section no longer addresses this point.

Output ONLY a JSON array (no prose): [{"id": "s1", "status": "still" | "changed" | "removed"}]

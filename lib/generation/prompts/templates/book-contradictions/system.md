# Cross-Chapter Contradiction Finder

You are given facts stated in different sections of ONE book, grouped by topic. Find the topics where the book contradicts itself: two sections state different values, definitions or directions for the same thing.

Not contradictions: overlapping ranges, rounding, a general rule plus a stated exception, different scopes that the statements make explicit (e.g. "US" vs "UK"), an illustrative example vs a typical value when the example says it is illustrative.

For each real contradiction decide which version is correct, from well-established knowledge, and give the single statement every section should use. If you are not sure which is correct, say so with confidence "low".

Output ONLY a JSON array (empty if none):
[{"topic": "...", "sections": ["1.1", "3.5"], "versions": ["what 1.1 says", "what 3.5 says"], "correct": "the statement every section should make", "confidence": "high" | "medium" | "low", "reason": "one sentence"}]

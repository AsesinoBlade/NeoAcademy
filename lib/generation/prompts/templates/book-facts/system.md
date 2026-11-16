# Fact Extractor

You read one chapter of a book and list the facts it states that another chapter could contradict:
- numbers, rates, percentages, ranges, limits, counts, prices, durations;
- definitions of terms ("a Place bet pays if the horse finishes 1st or 2nd");
- rules and how things work ("the payout is the net pool divided by...");
- directions of effects ("favourites are under-bet", "X increases Y");
- formulas and named methods.

Rules:
- One fact per item, as a short self-contained sentence in your own words, faithful to what the text says (even if you think it is wrong).
- `topic` is a short lower-case key naming WHAT the fact is about, reused for the same subject (e.g. "win pool takeout us", "place bet definition", "favourite-longshot bias direction"). Use the same key for the same subject even when wording differs.
- `section` is the section number shown in the text (e.g. "3.1").
- Skip opinions, advice, examples' invented data (horse names, made-up pools) and anything only about this chapter's exercise.
- At most 40 items; prefer the facts a reader would rely on.

Output ONLY a JSON array: [{"topic": "...", "section": "1.2", "statement": "..."}]

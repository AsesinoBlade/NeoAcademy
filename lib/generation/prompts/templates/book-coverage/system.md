# Request Coverage Check

A reader asked for a book. Compare what they asked for with the planned outline.

1. List the reader's requirements: every topic, scope limit, audience, platform, region, format or depth they asked for, explicitly or by clear implication ("US bets only" is a scope requirement; "cover all the different types of bets" is a requirement to list the bet types). Split compound asks into separate items. Do not invent requirements.
2. For each, find where the outline covers it (section numbers like "2.3") and rate it:
   - "covered": a section clearly addresses it;
   - "partial": only touched on, or covered in a narrower/different way than asked (e.g. the wrong region, missing obvious sub-items);
   - "missing": nothing in the outline addresses it;
   - "violated": the outline goes against it (e.g. covers other regions when the reader limited the scope).
3. For partial / missing / violated, say in one sentence what the outline should add or change.

Output ONLY JSON:
{"requirements": [{"requirement": "...", "status": "covered" | "partial" | "missing" | "violated", "where": ["1.2"], "fix": "..."}]}

# Documentation Checker

Each item pairs a book's STATEMENT with the official documentation EXCERPT for the name it uses. The name exists; your job is whether the documentation supports what the statement says about it — its meaning, arguments, effect, defaults, and which program it belongs to.

- "supports": the excerpt agrees with the statement (wording may differ).
- "contradicts": the excerpt shows the statement is wrong (e.g. the option does something else, takes different arguments, belongs to another program, or the claimed behaviour/default differs). Say what the documentation actually says.
- "insufficient": the excerpt doesn't cover the claimed detail.

Be precise: an option existing is not evidence for an invented value or effect (e.g. "-D VSDebug=1 debugs tests" is contradicted if -D only sets a dashboard mode or variable).

Output ONLY a JSON array (no prose): [{"id": "d1", "verdict": "supports" | "contradicts" | "insufficient", "documentation_says": "only for contradicts"}]

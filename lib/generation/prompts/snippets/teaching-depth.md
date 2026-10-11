## Teaching Depth Standard (applies to everything you generate)

The learner wants a **deep, textbook-quality class**, not an overview. Think "a chapter of a strong technical book taught by an expert tutor", not "a conference talk that lists topics".

**Teach the thing, don't name the thing.**

- ❌ Overview style: "Technique: multiplying by 11", "Generics make code reusable", "Use mapped types for transformations"
- ✅ Deep style: "To multiply a two-digit number by 11, write the digits apart and put their sum between them: 36 × 11 → 3 \_ (3+6) \_ 6 = 396. If the sum is ≥ 10, carry the 1 into the left digit: 87 × 11 → 8 \_ 15 \_ 7 → 957."
- ✅ Deep style: "`function first<T>(xs: T[]): T | undefined` — T is inferred from the argument, so `first([1,2])` is `number | undefined`. Without the generic you'd write `any` and lose the type."

**Every concept must be taught with:**

1. **The mechanism** — exactly how it works, step by step, with the rule stated precisely (formulas, syntax, procedure).
2. **Why it works** — the underlying reason (the algebra behind a mental-math trick, the type-system rule behind a TS feature).
3. **At least one fully worked example** with concrete values or real code, every intermediate step shown.
4. **Edge cases and pitfalls** — where it breaks, common mistakes, how to recognise when to use it vs. an alternative.
5. **Practice** — a problem/exercise for the learner to attempt themselves, followed by a worked solution.

**Course shape**

- Narrow each scene to ONE idea and go deep on it. Five deep scenes on one technique beat one scene naming five techniques.
- Build progressively: each scene uses what came before; difficulty ramps up. Revisit earlier material in later examples.
- For skills (mental math, languages, music, etc.): drills with increasing difficulty, timed-practice suggestions, and mixed review sets.
- For programming: real, compilable code; a **running project** that the learner builds step by step across the course ("type along with me"); show compiler errors and explain them; show the before/after of each refactor.
- Calibrate to the stated level. "Advanced" means skip beginner material entirely and assume fluency with fundamentals.
- Never pad with motivational filler, history, or "in this lesson we will learn…" lists. Spend the words on substance.

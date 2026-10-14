#!/usr/bin/env python3
"""
NeoAcademy math checker.

Reads a JSON list of checks on stdin, evaluates each one with a restricted
expression evaluator, and writes a JSON list of results to stdout.

Expressions are NOT executed with eval(). They are parsed with `ast` and only
a whitelist of node types is evaluated: numbers, arithmetic, comparisons,
lists/tuples, comprehensions, subscripts and calls to the helper functions
defined below. There is no attribute access, no imports, no names other than
helpers / loop variables, so model-written expressions cannot reach the file
system, network or interpreter internals.

Check kinds
  value     expression -> number, compared with the book's claimed number
  assert    expression -> must be True (e.g. a stated constraint)
  identity  lhs == rhs symbolically (SymPy), for algebra

Requires: Python 3.9+, numpy, sympy.
"""
import ast
import json
import math
import re
import sys

import numpy as np
import sympy

MAX_POW = 10_000
MAX_SEQ = 1_000_000
MAX_TRIALS = 500_000


class CheckError(Exception):
    pass


# ── Helpers available to expressions ───────────────────────────────────────


def _dist(dist):
    """A payout distribution: [[value, probability], ...]. Probabilities must sum to 1."""
    if not isinstance(dist, (list, tuple)) or not dist:
        raise CheckError("distribution must be a non-empty list of [value, probability] pairs")
    values = np.array([float(v) for v, _ in dist])
    probs = np.array([float(p) for _, p in dist])
    if (probs < 0).any():
        raise CheckError("distribution has a negative probability")
    total = probs.sum()
    if abs(total - 1.0) > 1e-6:
        raise CheckError(f"distribution probabilities sum to {total:.6g}, not 1")
    return values, probs


def ev(dist):
    """Expected value of a distribution."""
    v, p = _dist(dist)
    return float((v * p).sum())


def var(dist):
    """Variance of a distribution (population variance, using every outcome)."""
    v, p = _dist(dist)
    m = (v * p).sum()
    return float((((v - m) ** 2) * p).sum())


def std(dist):
    return math.sqrt(var(dist))


def prob_sum(dist):
    """Sum of the probabilities (to check a distribution is complete)."""
    return float(sum(float(p) for _, p in dist))


def prob_none(p, n):
    """Probability an event with per-trial probability p never happens in n independent trials."""
    return (1 - p) ** n


def prob_at_least_one(p, n):
    return 1 - (1 - p) ** n


def binom_pmf(k, n, p):
    return math.comb(int(n), int(k)) * p ** k * (1 - p) ** (n - k)


def binom_cdf(k, n, p):
    return sum(binom_pmf(i, n, p) for i in range(0, int(k) + 1))


def max_loss(stake, spins):
    """Largest possible loss: every stake lost (payouts cannot be negative)."""
    return stake * spins


def ruin_probability(dist, stake, bankroll, spins, trials=100_000, seed=12345):
    """
    Monte Carlo: probability the bankroll drops below one stake before `spins`
    paid spins are completed. `dist` gives GROSS payouts as multiples of the
    stake (0 = losing spin, 2 = stake back plus one stake profit).
    """
    trials = int(min(trials, MAX_TRIALS))
    v, p = _dist(dist)
    rng = np.random.default_rng(int(seed))
    balance = np.full(trials, float(bankroll))
    alive = np.ones(trials, dtype=bool)
    for _ in range(int(spins)):
        can_bet = alive & (balance >= stake - 1e-12)
        alive &= can_bet
        if not alive.any():
            break
        outcomes = rng.choice(v, size=trials, p=p)
        balance = np.where(alive, balance - stake + outcomes * stake, balance)
    return float((~alive).mean())


def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs)


def pct(x):
    """Percent to fraction: pct(96.5) -> 0.965."""
    return x / 100


HELPERS = {
    # distributions / probability
    "ev": ev, "var": var, "std": std, "prob_sum": prob_sum,
    "prob_none": prob_none, "prob_at_least_one": prob_at_least_one,
    "binom_pmf": binom_pmf, "binom_cdf": binom_cdf,
    "ruin_probability": ruin_probability, "max_loss": max_loss,
    # general maths
    "sqrt": math.sqrt, "exp": math.exp, "log": math.log, "log10": math.log10, "log2": math.log2,
    "floor": math.floor, "ceil": math.ceil, "comb": math.comb, "perm": math.perm,
    "factorial": math.factorial, "gcd": math.gcd,
    "abs": abs, "round": round, "min": min, "max": max, "sum": sum, "len": len,
    "mean": mean, "pct": pct, "range": range,
    "pi": math.pi, "e": math.e, "True": True, "False": False,
}

# ── Restricted evaluator ───────────────────────────────────────────────────

BIN_OPS = {
    ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b, ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b,
    ast.Pow: None,
}
CMP_OPS = {
    ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b, ast.Lt: lambda a, b: a < b,
    ast.LtE: lambda a, b: a <= b, ast.Gt: lambda a, b: a > b, ast.GtE: lambda a, b: a >= b,
}


class Evaluator:
    def __init__(self, symbolic=False):
        self.symbolic = symbolic  # unknown names become SymPy symbols
        self.scopes = [{}]

    def lookup(self, name):
        for scope in reversed(self.scopes):
            if name in scope:
                return scope[name]
        if name in HELPERS:
            return HELPERS[name]
        if self.symbolic and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name) and not name.startswith("_"):
            return sympy.Symbol(name)
        raise CheckError(f"unknown name '{name}'")

    def ev(self, node):
        method = getattr(self, f"_{type(node).__name__}", None)
        if method is None:
            raise CheckError(f"syntax not allowed: {type(node).__name__}")
        return method(node)

    def _Expression(self, n):
        return self.ev(n.body)

    def _Constant(self, n):
        if isinstance(n.value, (int, float, bool)) or n.value is None:
            return n.value
        raise CheckError("only numeric constants are allowed")

    def _Name(self, n):
        return self.lookup(n.id)

    def _List(self, n):
        return [self.ev(e) for e in n.elts]

    def _Tuple(self, n):
        return tuple(self.ev(e) for e in n.elts)

    def _UnaryOp(self, n):
        v = self.ev(n.operand)
        if isinstance(n.op, ast.USub):
            return -v
        if isinstance(n.op, ast.UAdd):
            return +v
        if isinstance(n.op, ast.Not):
            return not v
        raise CheckError("unary operator not allowed")

    def _BinOp(self, n):
        a, b = self.ev(n.left), self.ev(n.right)
        if isinstance(n.op, ast.Pow):
            if isinstance(b, (int, float)) and abs(b) > MAX_POW:
                raise CheckError("exponent too large")
            return a ** b
        op = BIN_OPS.get(type(n.op))
        if op is None:
            raise CheckError("operator not allowed")
        return op(a, b)

    def _BoolOp(self, n):
        values = [self.ev(v) for v in n.values]
        return all(values) if isinstance(n.op, ast.And) else any(values)

    def _Compare(self, n):
        left = self.ev(n.left)
        for op, comp in zip(n.ops, n.comparators):
            fn = CMP_OPS.get(type(op))
            if fn is None:
                raise CheckError("comparison not allowed")
            right = self.ev(comp)
            if not fn(left, right):
                return False
            left = right
        return True

    def _IfExp(self, n):
        return self.ev(n.body) if self.ev(n.test) else self.ev(n.orelse)

    def _Subscript(self, n):
        target = self.ev(n.value)
        index = self.ev(n.slice)
        return target[index]

    def _Slice(self, n):
        return slice(
            self.ev(n.lower) if n.lower else None,
            self.ev(n.upper) if n.upper else None,
            self.ev(n.step) if n.step else None,
        )

    def _Call(self, n):
        if not isinstance(n.func, ast.Name) or n.func.id not in HELPERS:
            raise CheckError("only the provided helper functions may be called")
        fn = HELPERS[n.func.id]
        args = [self.ev(a) for a in n.args]
        kwargs = {k.arg: self.ev(k.value) for k in n.keywords if k.arg}
        if fn is range and any(abs(a) > MAX_SEQ for a in args if isinstance(a, int)):
            raise CheckError("range too large")
        return fn(*args, **kwargs)

    def _comprehension(self, generators, element, make):
        results = []

        def walk(i):
            if i == len(generators):
                results.append(self.ev(element))
                if len(results) > MAX_SEQ:
                    raise CheckError("sequence too large")
                return
            gen = generators[i]
            for item in self.ev(gen.iter):
                self.scopes.append({})
                self._bind(gen.target, item)
                if all(self.ev(cond) for cond in gen.ifs):
                    walk(i + 1)
                self.scopes.pop()

        walk(0)
        return make(results)

    def _bind(self, target, value):
        if isinstance(target, ast.Name):
            if target.id in HELPERS:
                raise CheckError("cannot rebind a helper name")
            self.scopes[-1][target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            values = list(value)
            if len(values) != len(target.elts):
                raise CheckError("unpacking mismatch")
            for t, v in zip(target.elts, values):
                self._bind(t, v)
        else:
            raise CheckError("loop target not allowed")

    def _ListComp(self, n):
        return self._comprehension(n.generators, n.elt, list)

    def _GeneratorExp(self, n):
        return self._comprehension(n.generators, n.elt, list)


def evaluate(expression, symbolic=False):
    if not isinstance(expression, str) or len(expression) > 4000:
        raise CheckError("expression missing or too long")
    tree = ast.parse(expression.strip(), mode="eval")
    return Evaluator(symbolic=symbolic).ev(tree)


# ── Comparing with what the book claims ────────────────────────────────────


def parse_claimed(text):
    """
    "$1,375.50" -> (1375.5, 0.005); "90.5%" -> (0.905, 0.0005); "22×" -> (22, 0.5).
    Tolerance = half a unit in the last written digit, so rounded figures pass.
    """
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return float(text), max(abs(text) * 1e-9, 1e-12), False
    s = str(text).strip()
    is_pct = "%" in s
    m = re.search(r"-?\d[\d,]*(?:\.(\d+))?|-?\.\d+", s.replace("−", "-"))
    if not m:
        raise CheckError(f"no number in claimed value '{text}'")
    number = float(m.group(0).replace(",", ""))
    # "-$5", "−£12", "($5)" are negative amounts written around a currency sign.
    if number > 0 and (re.match(r"^[\s(]*[-−]\s*[$€£]", s) or re.match(r"^\s*\(\s*[$€£]?\s*\d[\d,.]*\s*\)", s)):
        number = -number
    decimals = len(m.group(1)) if m.group(1) else 0
    tol = 0.5 * 10 ** (-decimals)
    if is_pct:
        number, tol = number / 100, tol / 100
    return number, tol, is_pct


def to_float(x):
    if isinstance(x, (sympy.Basic,)):
        return float(x.evalf())
    if isinstance(x, (np.floating, np.integer)):
        return float(x)
    return float(x)


def run_check(check):
    kind = check.get("kind", "value")
    result = {"id": check.get("id"), "kind": kind}
    try:
        if kind == "identity":
            lhs = evaluate(check["lhs"], symbolic=True)
            rhs = evaluate(check["rhs"], symbolic=True)
            ok = sympy.simplify(sympy.sympify(lhs) - sympy.sympify(rhs)) == 0
            result.update(ok=bool(ok), computed=str(sympy.simplify(sympy.sympify(lhs) - sympy.sympify(rhs))))
        elif kind == "assert":
            value = evaluate(check["expression"])
            result.update(ok=bool(value), computed=bool(value))
        else:
            value = to_float(evaluate(check["expression"]))
            claimed, tol, is_pct = parse_claimed(check["claimed"])
            extra = float(check.get("tolerance") or 0)
            ok = math.isclose(value, claimed, rel_tol=1e-9, abs_tol=max(tol, extra))
            result.update(ok=bool(ok), computed=value, claimedValue=claimed, tolerance=max(tol, extra))
    except CheckError as e:
        result.update(ok=None, error=str(e))
    except (ZeroDivisionError, OverflowError, ValueError, TypeError, IndexError, KeyError, SyntaxError) as e:
        result.update(ok=None, error=f"{type(e).__name__}: {e}")
    return result


def main():
    checks = json.load(sys.stdin)
    if not isinstance(checks, list):
        raise SystemExit("expected a JSON list of checks")
    json.dump([run_check(c) for c in checks[:200]], sys.stdout)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        print(json.dumps({"ok": True, "numpy": np.__version__, "sympy": sympy.__version__}))
    else:
        main()

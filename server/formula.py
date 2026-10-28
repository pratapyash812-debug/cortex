"""Formula expressions for database properties.

A formula is a small expression over a note's properties, kept in .cortex/bases.json and computed when a
database is shown; it is never written into the notes.

    price * qty                      arithmetic: + - * / %  (+ also joins text)
    if(done, "Shipped", "Open")      comparisons: == != < <= > >=   logic: and or not
    concat(title, " (", status, ")") dateDiff(due, now(), "days")
    {Due date}                       properties with spaces go in braces, or prop("Due date")

Values are None, bool, number, text, datetime (naive, local) or list. An empty property counts as 0 in
arithmetic and as "" when joined to text.
"""
from __future__ import annotations

import functools
import math
import re
from datetime import date, datetime, timedelta
from typing import Callable

MAX_LENGTH = 1000
MAX_DEPTH = 40
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$")
TOKEN_RE = re.compile(r"""\s*(?:
    (?P<num>\d+(?:\.\d+)?)
  | (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
  | (?P<brace>\{[^}]*\})
  | (?P<id>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op>==|!=|<>|<=|>=|&&|\|\||[-+*/%()<>=!,])
)""", re.X)
UNIT_SECONDS = {"seconds": 1, "minutes": 60, "hours": 3600, "days": 86400, "weeks": 604800}


class FormulaError(ValueError):
    """A formula that cannot be parsed or evaluated; the message is shown to the user."""


# ---- parsing -------------------------------------------------------------------------------------------------
def tokenize(src: str) -> list[tuple[str, str]]:
    if len(src) > MAX_LENGTH:
        raise FormulaError(f"formula is longer than {MAX_LENGTH} characters")
    out, pos = [], 0
    while pos < len(src):
        if not src[pos:].strip():
            break
        m = TOKEN_RE.match(src, pos)
        if not m:
            raise FormulaError(f"unexpected character {src[pos:].lstrip()[0]!r}")
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
        pos = m.end()
    return out


class Parser:
    def __init__(self, src: str):
        self.toks = tokenize(src)
        self.i = 0
        self.depth = 0

    def peek(self) -> tuple[str, str] | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self, value: str | None = None) -> tuple[str, str]:
        t = self.peek()
        if t is None:
            raise FormulaError("the formula ends too early")
        if value is not None and t[1] != value:
            raise FormulaError(f"expected {value!r} but found {t[1]!r}")
        self.i += 1
        return t

    def at(self, *values: str) -> bool:
        t = self.peek()
        return t is not None and t[0] in ("op", "id") and t[1].lower() in values

    def parse(self):
        if not self.toks:
            raise FormulaError("the formula is empty")
        node = self.or_()
        if self.peek() is not None:
            raise FormulaError(f"unexpected {self.peek()[1]!r}")
        return node

    def nest(self, fn):
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise FormulaError("the formula is nested too deeply")
        try:
            return fn()
        finally:
            self.depth -= 1

    def or_(self):
        node = self.and_()
        while self.at("or", "||"):
            self.take()
            node = ("or", node, self.and_())
        return node

    def and_(self):
        node = self.not_()
        while self.at("and", "&&"):
            self.take()
            node = ("and", node, self.not_())
        return node

    def not_(self):
        if self.at("not", "!"):
            self.take()
            return ("not", self.nest(self.not_))
        return self.cmp()

    def cmp(self):
        node = self.add()
        if self.at("==", "=", "!=", "<>", "<", "<=", ">", ">="):
            op = self.take()[1]
            node = ("cmp", {"=": "==", "<>": "!="}.get(op, op), node, self.add())
        return node

    def add(self):
        node = self.mul()
        while self.at("+", "-"):
            node = ("bin", self.take()[1], node, self.mul())
        return node

    def mul(self):
        node = self.unary()
        while self.at("*", "/", "%"):
            node = ("bin", self.take()[1], node, self.unary())
        return node

    def unary(self):
        if self.at("-"):
            self.take()
            return ("neg", self.nest(self.unary))
        return self.primary()

    def primary(self):
        kind, text = self.take()
        if kind == "num":
            return ("lit", float(text) if "." in text else int(text))
        if kind == "str":
            return ("lit", re.sub(r"\\(.)", r"\1", text[1:-1]))
        if kind == "brace":
            return ("prop", text[1:-1].strip())
        if kind == "op" and text == "(":
            node = self.nest(self.or_)
            self.take(")")
            return node
        if kind == "id":
            low = text.lower()
            if self.peek() == ("op", "("):
                self.take()
                args = []
                if not self.at(")"):
                    args.append(self.nest(self.or_))
                    while self.at(","):
                        self.take()
                        args.append(self.nest(self.or_))
                self.take(")")
                if low not in FUNCTIONS and low != "if":
                    raise FormulaError(f"unknown function {text}()")
                return ("call", low, args)
            if low in ("true", "false"):
                return ("lit", low == "true")
            return ("prop", text)
        raise FormulaError(f"unexpected {text!r}")


@functools.lru_cache(maxsize=256)
def parse(src: str):
    """The formula's syntax tree (parsed once per formula, not once per row). Raises FormulaError with a readable reason."""
    try:
        return Parser(src).parse()
    except RecursionError as e:
        raise FormulaError("the formula is nested too deeply") from e


# ---- values --------------------------------------------------------------------------------------------------
def to_datetime(v):
    """Dates written as YYYY-MM-DD or YYYY-MM-DDTHH:MM become datetimes; anything else is returned unchanged."""
    if isinstance(v, datetime):
        return v.replace(tzinfo=None)
    if isinstance(v, date):
        return datetime(v.year, v.month, v.day)
    if isinstance(v, str) and DATE_RE.match(v.strip()):
        try:
            return datetime.fromisoformat(v.strip().replace(" ", "T"))
        except ValueError:
            return v
    return v


def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def clean_number(x):
    """Whole floats become ints so 3.0 shows as 3; non-finite results are errors."""
    if isinstance(x, float):
        if not math.isfinite(x):
            raise FormulaError("the result is not a finite number")
        if x == int(x) and abs(x) < 1e15:
            return int(x)
        return round(x, 10)
    return x


def as_number(v):
    v = to_datetime(v)
    if v is None:
        return 0
    if isinstance(v, bool):
        return int(v)
    if is_number(v):
        return v
    if isinstance(v, str):
        try:
            return float(v) if "." in v else int(v)
        except ValueError:
            pass
    raise FormulaError(f"{text_of(v)!r} is not a number")


def text_of(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(clean_number(v))
    if isinstance(v, datetime):
        return output(v)
    if isinstance(v, list):
        return ", ".join(text_of(x) for x in v)
    return str(v)


def output(v):
    """A computed value as JSON: datetimes become ISO text (date only at midnight)."""
    if isinstance(v, datetime):
        return v.date().isoformat() if v == v.replace(hour=0, minute=0, second=0, microsecond=0) else v.isoformat(timespec="seconds")
    if isinstance(v, float):
        return clean_number(v)
    if isinstance(v, list):
        return [output(x) for x in v]
    return v


def truthy(v) -> bool:
    return bool(v) and v != 0


def compare(op: str, a, b) -> bool:
    a, b = to_datetime(a), to_datetime(b)
    if op in ("==", "!="):
        if is_number(a) and is_number(b):
            same = a == b
        else:
            same = a == b or (isinstance(a, str) and isinstance(b, str) and a.lower() == b.lower())
        return same if op == "==" else not same
    if a is None or b is None:
        return False
    if isinstance(a, str) and isinstance(b, str):
        a, b = a.lower(), b.lower()
    elif not ((is_number(a) and is_number(b)) or (isinstance(a, datetime) and isinstance(b, datetime))):
        raise FormulaError(f"cannot compare {text_of(a)!r} with {text_of(b)!r}")
    return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


# ---- evaluation ----------------------------------------------------------------------------------------------
class Context:
    """lookup(name) returns a property value or raises FormulaError for an unknown property."""

    def __init__(self, lookup: Callable[[str], object], now: datetime | None = None):
        self.lookup = lookup
        self.now = (now or datetime.now()).replace(microsecond=0)


def _date_arg(v, fn: str) -> datetime:
    v = to_datetime(v)
    if not isinstance(v, datetime):
        raise FormulaError(f"{fn}() needs a date, not {text_of(v)!r}")
    return v


def _unit(u) -> str:
    unit = text_of(u or "days").lower()
    unit = unit if unit.endswith("s") else unit + "s"
    if unit not in UNIT_SECONDS:
        raise FormulaError("unit must be seconds, minutes, hours, days or weeks")
    return unit


def _date_diff(ctx, a, b, unit=None):
    if a is None or b is None:
        return None
    seconds = (_date_arg(a, "dateDiff") - _date_arg(b, "dateDiff")).total_seconds()
    return clean_number(seconds / UNIT_SECONDS[_unit(unit)])


def _date_add(ctx, d, n, unit=None):
    if d is None:
        return None
    return _date_arg(d, "dateAdd") + timedelta(seconds=as_number(n) * UNIT_SECONDS[_unit(unit)])


def _numbers(args):
    items = args[0] if len(args) == 1 and isinstance(args[0], list) else args
    return [as_number(x) for x in items if x is not None]


def _round(ctx, x, digits=0):
    x, d = as_number(x), int(as_number(digits))
    if abs(d) > 15:
        raise FormulaError("round() keeps between -15 and 15 digits")
    return clean_number(math.floor(x * 10 ** d + 0.5) / 10 ** d) if d >= 0 else clean_number(round(x, d))


def _date_part(name):
    def part(ctx, d):
        return None if d is None else getattr(_date_arg(d, name), name)
    return part


FUNCTIONS: dict[str, Callable] = {
    "concat": lambda ctx, *a: "".join(text_of(x) for x in a),
    "join": lambda ctx, items, sep=", ": text_of(sep).join(text_of(x) for x in (items if isinstance(items, list) else [items])),
    "upper": lambda ctx, s: text_of(s).upper(),
    "lower": lambda ctx, s: text_of(s).lower(),
    "trim": lambda ctx, s: text_of(s).strip(),
    "replace": lambda ctx, s, a, b: text_of(s).replace(text_of(a), text_of(b)),
    "length": lambda ctx, v: len(v) if isinstance(v, list) else len(text_of(v)),
    "contains": lambda ctx, h, n: (any(text_of(x).lower() == text_of(n).lower() for x in h) if isinstance(h, list)
                                   else text_of(n).lower() in text_of(h).lower()),
    "empty": lambda ctx, v: v is None or v == "" or v == [],
    "round": _round,
    "floor": lambda ctx, x: math.floor(as_number(x)),
    "ceil": lambda ctx, x: math.ceil(as_number(x)),
    "abs": lambda ctx, x: abs(as_number(x)),
    "min": lambda ctx, *a: min(_numbers(a)) if _numbers(a) else None,
    "max": lambda ctx, *a: max(_numbers(a)) if _numbers(a) else None,
    "sum": lambda ctx, *a: clean_number(sum(_numbers(a))),
    "number": lambda ctx, v: as_number(v),
    "now": lambda ctx: ctx.now,
    "today": lambda ctx: ctx.now.replace(hour=0, minute=0, second=0),
    "datediff": _date_diff,
    "dateadd": _date_add,
    "year": _date_part("year"),
    "month": _date_part("month"),
    "day": _date_part("day"),
    "prop": lambda ctx, name: to_datetime(ctx.lookup(text_of(name))),
}
ARITY = {"if": (2, 3), "now": (0, 0), "today": (0, 0), "prop": (1, 1), "datediff": (2, 3), "dateadd": (2, 3), "concat": (0, 99),
         "min": (1, 99), "max": (1, 99), "sum": (1, 99), "round": (1, 2), "replace": (3, 3), "join": (1, 2),
         "contains": (2, 2)}


def evaluate(node, ctx: Context):
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "prop":
        return to_datetime(ctx.lookup(node[1]))
    if kind == "neg":
        return -as_number(evaluate(node[1], ctx))
    if kind == "not":
        return not truthy(evaluate(node[1], ctx))
    if kind == "and":
        return truthy(evaluate(node[1], ctx)) and truthy(evaluate(node[2], ctx))
    if kind == "or":
        return truthy(evaluate(node[1], ctx)) or truthy(evaluate(node[2], ctx))
    if kind == "cmp":
        return compare(node[1], evaluate(node[2], ctx), evaluate(node[3], ctx))
    if kind == "bin":
        op, a, b = node[1], evaluate(node[2], ctx), evaluate(node[3], ctx)
        if op == "+" and (isinstance(a, str) or isinstance(b, str) or isinstance(a, list) or isinstance(b, list)):
            return text_of(a) + text_of(b)
        if isinstance(a, datetime) or isinstance(b, datetime):
            raise FormulaError("use dateDiff() or dateAdd() to calculate with dates")
        x, y = as_number(a), as_number(b)
        if op in ("/", "%") and y == 0:
            raise FormulaError("division by zero")
        return clean_number({"+": lambda: x + y, "-": lambda: x - y, "*": lambda: x * y, "/": lambda: x / y, "%": lambda: x % y}[op]())
    if kind == "call":
        name, args = node[1], node[2]
        lo, hi = ARITY.get(name, (1, 1))
        if not lo <= len(args) <= hi:
            raise FormulaError(f"{name}() takes {lo if lo == hi else f'{lo} to {hi}'} argument(s)")
        if name == "if":
            if truthy(evaluate(args[0], ctx)):
                return evaluate(args[1], ctx)
            return evaluate(args[2], ctx) if len(args) == 3 else None
        return FUNCTIONS[name](ctx, *[evaluate(a, ctx) for a in args])
    raise FormulaError("unsupported expression")


def run(src: str, ctx: Context):
    """Parse and evaluate; the result is ready for JSON."""
    try:
        return output(evaluate(parse(src), ctx))
    except RecursionError as e:
        raise FormulaError("the formula is nested too deeply") from e
    except OverflowError as e:  # a number or date too large to represent
        raise FormulaError("the result is out of range") from e
    except TypeError as e:  # a wrong argument type for a function
        raise FormulaError(f"wrong kind of value: {e}") from e

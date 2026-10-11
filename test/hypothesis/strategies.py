"""
Generators for the state machine: the mock's settings, message ids, messages
and their serialisations, RFC 5646 language tags, and JSON values.

Each covers the documented domain of what it stands for. Where a value must
be honest (a message the Personal Agent may send), it is constructed
honest, never filtered (techniques/generators.md).
"""

from __future__ import annotations

import base64
import json
import string
from typing import Any

from hypothesis import strategies as st

# ---- the mock Company's settings: each a way real Companies differ ----

CONFIGS = st.fixed_dictionaries(
    {
        "strictAssertions": st.booleans(),
        "clientAssertionAud": st.sampled_from(["lenient", "exact"]),
        "rotateRefreshTokens": st.booleans(),
        "reuseDetection": st.booleans(),
        "requireNonce": st.booleans(),
        "nonceScope": st.sampled_from(["company", "origin"]),
        "omitTokenScope": st.booleans(),
        "issuerTrailingSlash": st.booleans(),
        "endSessionsOnSignOut": st.booleans(),
        "endedSessionError": st.sampled_from(["invalid_token", "invalid_session"]),
        "streaming": st.booleans(),
        "textDeltas": st.booleans(),
        "sseKeepAlive": st.booleans(),
        "agentReplies": st.booleans(),
    }
)

# ---- ids (7.2: 1 to 256 characters of the URL-safe base64 alphabet) ----

ID_ALPHABET = string.ascii_letters + string.digits + "-_"
MESSAGE_IDS = st.one_of(
    st.text(alphabet=ID_ALPHABET, min_size=1, max_size=256),
    st.binary(min_size=16, max_size=16).map(lambda b: "msg_" + base64.urlsafe_b64encode(b).rstrip(b"=").decode()),
)

# ---- RFC 5646 language tags, well-formed by its ABNF (2.1) ----

_A, _D, _AN = "[A-Za-z]", "[0-9]", "[A-Za-z0-9]"
_LANGUAGE = f"(?:{_A}{{2,3}}(?:-{_A}{{3}}){{0,3}}|{_A}{{4}}|{_A}{{5,8}})"
_SCRIPT = f"{_A}{{4}}"
_REGION = f"(?:{_A}{{2}}|{_D}{{3}})"
_VARIANT = f"(?:{_AN}{{5,8}}|{_D}{_AN}{{3}})"
_EXTENSION = f"[0-9A-WY-Za-wy-z](?:-{_AN}{{2,8}})+"
_PRIVATEUSE = f"[xX](?:-{_AN}{{1,8}})+"
_LANGTAG = f"{_LANGUAGE}(?:-{_SCRIPT})?(?:-{_REGION})?(?:-{_VARIANT})*(?:-{_EXTENSION})*(?:-{_PRIVATEUSE})?"
# RFC 5646's irregular grandfathered tags are well-formed too.
_IRREGULAR = ["en-GB-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon", "i-lux", "i-mingo",
              "i-navajo", "i-pwn", "i-tao", "i-tay", "i-tsu", "sgn-BE-FR", "sgn-BE-NL", "sgn-CH-DE"]
LOCALES = st.one_of(
    st.from_regex(f"(?:{_LANGTAG}|{_PRIVATEUSE})", fullmatch=True),
    st.sampled_from(["en-US", "zh-Hant-TW", "es-419", "de-CH-1901", "en-US-u-ca-gregory", "sr-Latn-RS"]),
    st.sampled_from(_IRREGULAR),
)

# ---- JSON values (RFC 8259); integers within the interoperable range (section 6) ----

_SAFE = 2**53 - 1
JSON_SCALARS = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(min_value=-_SAFE, max_value=_SAFE),
    st.floats(allow_nan=False, allow_infinity=False),
    st.text(),
)
JSON_VALUES = st.recursive(
    JSON_SCALARS,
    lambda inner: st.one_of(st.lists(inner, max_size=3), st.dictionaries(st.text(max_size=8), inner, max_size=3)),
    max_leaves=8,
)
DATA = st.dictionaries(st.text(max_size=12), JSON_VALUES, max_size=4)

# What JavaScript's String.prototype.trim and Python's str.strip remove, together.
_TRIMMED = "".join(chr(c) for c in range(0x110000) if chr(c).isspace()) + "﻿"


def honest_text(text: str) -> str:
    """
    7.4: JSON belongs in `data`, never in `text`. Text that could read as
    JSON (its first non-blank character opens an object or array) gets a
    prose prefix, so the Personal Agent never sends JSON as text.
    """
    return "Note: " + text if text.lstrip(_TRIMMED)[:1] in ("{", "[") else text


@st.composite
def messages(draw: st.DrawFn, prompts: list[str]) -> dict[str, Any]:
    """A message as a Personal Agent may send it (7.3, 7.4): at least one of text, data and context."""
    parts = draw(st.sets(st.sampled_from(["text", "data", "context"]), min_size=1))
    message: dict[str, Any] = {"sender": draw(st.sampled_from(["agent", "human"]))}
    if "text" in parts:
        message["text"] = honest_text(draw(st.one_of(st.text(), st.sampled_from(prompts))))
    if "data" in parts:
        message["data"] = draw(DATA)
    if "context" in parts:
        context = draw(
            st.fixed_dictionaries(
                {},
                optional={"locale": LOCALES, "time_zone": st.timezone_keys(), "user_available": st.booleans()},
            )
        )
        message["context"] = context
    return message


@st.composite
def serialisations(draw: st.DrawFn, message: dict[str, Any]) -> str:
    """
    One JSON text for a message: its members, and those of `data`, in any
    order, with or without `\\u` escapes and spaces. RFC 8259 makes every
    one of these the same value: object members are unordered (section 4).
    """
    def reorder(value: dict[str, Any]) -> dict[str, Any]:
        keys = draw(st.permutations(list(value)))
        return {key: value[key] for key in keys}

    shaped = reorder(message)
    if isinstance(shaped.get("data"), dict):
        shaped["data"] = reorder(shaped["data"])
    if isinstance(shaped.get("context"), dict):
        shaped["context"] = reorder(shaped["context"])
    separators = draw(st.sampled_from([(",", ":"), (", ", ": ")]))
    return json.dumps(shaped, ensure_ascii=draw(st.booleans()), separators=separators, allow_nan=False)


def canonical(value: Any) -> str:
    """A JSON value's identity, ignoring member order, for "the same content" (7.3)."""

    def norm(item: Any) -> Any:
        if isinstance(item, bool) or item is None or isinstance(item, str):
            return item
        if isinstance(item, (int, float)):
            number = float(item)
            return int(number) if number.is_integer() else number
        if isinstance(item, list):
            return [norm(x) for x in item]
        return {key: norm(x) for key, x in item.items()}

    return json.dumps(norm(value), sort_keys=True, ensure_ascii=False)

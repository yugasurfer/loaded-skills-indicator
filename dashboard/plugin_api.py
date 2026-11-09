"""Loaded Skills Indicator: backend half.

Mounted at ``/api/plugins/loaded-skills-indicator/`` by the Hermes gateway/web
server. It answers ONE question for the desktop status-bar chip:

    which skills are currently READ INTO this conversation's context,
    which of those were pruned by context compression, and nothing else.

Why a backend at all: the gateway's ``session.history`` RPC deliberately
strips tool-result bodies (except write_file / patch / skill_manage), so a
renderer-only plugin can see *that* ``skill_view`` ran but not whether the
body is still in the transcript or was reduced to a ``[SKILL_PRUNED: ...]``
marker. The durable transcript in ``state.db`` has the bodies, so the exact
answer is computed here and shipped as a compact list.

Derivation (mirrors the agent's own rules):
  * assistant rows carry ``tool_calls`` -> map ``tool_call_id`` to the
    ``skill_view`` argument name;
  * a ``skill_view`` tool row with a body -> that skill is FULL;
  * a tool row whose body is the canonical prune marker -> PRUNED;
  * failed loads (``success: false`` / ``[skill_view] ... FAILED``) are
    ignored: nothing was read;
  * a ``/skill``, bundle or auto-load scaffold turn loads every skill it
    names inline (``agent.skill_commands.skills_loaded_by_scaffold``, with a
    local fallback if that helper moves);
  * prune markers in any row's text (compaction summaries) -> PRUNED.

Only ACTIVE rows are read (``active = 1`` and not ``compacted``), i.e. what
the model actually holds right now. A skill whose body was summarized away
therefore drops out of the count instead of lying about it.

Read-only: the connection is ``mode=ro``, no writes, no credential handling.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query

router = APIRouter()

SKILL_TOOL_NAMES = frozenset({"skill_view"})
FULL = "full"
PRUNED = "pruned"

# Canonical marker: "[SKILL_PRUNED: content lost in compression; reload with skill_view(name='x')]"
_PRUNED_RE = re.compile(r"\[SKILL_PRUNED:[^\]]*?skill_view\(name='([^']+)'\)")

# Inline skill payloads the gateway prepends to a user turn: the /skill command,
# a bundle/stacked load, and the channel-bound auto-load on a new session. These
# formats are part of the stored transcript, so the shapes below are parsed
# locally (no import of Hermes internals): a shape change shows up as "no
# inline loads detected", never as a crash.
_INVOKED_PREFIX = '[IMPORTANT: The user has invoked the "'
_INVOKED_NAME_RE = re.compile(r'^\[IMPORTANT: The user has invoked the "([^"]*)" skill')
_SINGLE_MARKER = "The full skill content is loaded below.]"
_BUNDLE_MARKER = " skill bundle,"
_BUNDLE_LOADED_RE = re.compile(r"^Skills loaded: (.+)$", re.MULTILINE)
_AUTO_LOAD_RE = re.compile(
    r'^\[IMPORTANT: The "([^"]*)" skill is auto-loaded\. Follow its instructions for this session\.\]'
)

_CACHE_TTL = 1.5  # seconds; one poll cadence, so a burst of renders is free
_AVAILABLE_TTL = 30.0  # the skills tree changes on install, not per turn
_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}
_available_cache: dict[str, tuple[float, dict]] = {}


# ---------------------------------------------------------------- paths -----

def _hermes_home() -> Path:
    """This request's profile home (the plugin route runs inside a config scope)."""
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        home = os.environ.get("HERMES_HOME")
        return Path(home) if home else Path.home() / ".hermes"


def _state_db(home: Path) -> Path:
    return home / "state.db"


def _candidate_dbs() -> list[Path]:
    """Transcript stores to try, best guess first.

    The router may run in a plugin host whose process home is the launch
    profile (``~/.hermes``) while the request belongs to a named profile whose
    row lives in ``profiles/<name>/state.db``. Rather than trust one home, try
    this request's home, the default root, then every profile — a handful of
    read-only connections, only on a cache miss.
    """
    paths: list[Path] = [_state_db(_hermes_home())]
    try:
        from hermes_constants import get_default_hermes_root

        root = Path(get_default_hermes_root())
        paths.append(_state_db(root))
        paths.extend(sorted((root / "profiles").glob("*/state.db")))
    except Exception:
        pass
    return [p for p in dict.fromkeys(paths) if p.exists()]


def _read_conn(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


# ------------------------------------------------------------- detection ----

def _scaffold_skills(content: Any) -> list[str]:
    """Skills an inline /skill, bundle or auto-load turn carries."""
    if not isinstance(content, str) or not content.strip():
        return []
    if content.startswith(_INVOKED_PREFIX):
        header = content.split("\n", 1)[0]
        if _BUNDLE_MARKER in header:
            loaded = _BUNDLE_LOADED_RE.search(content)
            if not loaded:
                return []
            return [n.lstrip("/").strip() for n in loaded.group(1).split(",") if n.strip()]
        match = _INVOKED_NAME_RE.match(header)
        if match and header.endswith(_SINGLE_MARKER) and match.group(1):
            return [match.group(1)]
        return []
    match = _AUTO_LOAD_RE.match(content.split("\n", 1)[0])
    return [match.group(1)] if match and match.group(1) else []


def _json(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def _tool_call_skills(row: sqlite3.Row) -> list[tuple[str, str]]:
    """(tool_call_id, skill name) for every skill_view call on an assistant row."""
    calls = _json(row["tool_calls"])
    out: list[tuple[str, str]] = []
    for call in calls if isinstance(calls, list) else ():
        if not isinstance(call, dict):
            continue
        fn = call.get("function") if isinstance(call.get("function"), dict) else {}
        if fn.get("name") not in SKILL_TOOL_NAMES:
            continue
        args = _json(fn.get("arguments")) or {}
        name = str(args.get("name") or args.get("skill") or args.get("path") or "").strip()
        if name:
            out.append((str(call.get("id") or call.get("call_id") or ""), name))
    return out


def _tool_row(content: Any) -> tuple[str, str]:
    """``(FULL|PRUNED|"", skill_dir)`` for one skill_view tool result.

    ``skill_dir`` is the directory the body was read from, when the result
    carries one — linked-file reads and prune markers do not.
    """
    if not isinstance(content, str) or not content.strip():
        return "", ""
    if "[SKILL_PRUNED" in content:
        return PRUNED, ""
    payload = _json(content)
    if isinstance(payload, dict):
        if payload.get("success") is False or payload.get("error"):
            return "", ""
        return FULL, str(payload.get("skill_dir") or "").strip()
    head = content.lstrip().split("\n", 1)[0]
    if head.startswith("[skill_view]") and "FAILED" in head:
        return "", ""
    return FULL, ""


def analyse(rows: list[sqlite3.Row]) -> list[dict]:
    """Ordered, deduped skill states; the LAST event for a name wins.

    Two facts ride along for the body view: ``dir`` (the directory a read came
    from, when the result carried one) and ``read_at`` (the time of the last
    event that actually put the body in front of the model — a compression
    prune updates ``state``/``last_at`` but must never move ``read_at``).
    """
    order: list[str] = []
    state: dict[str, dict] = {}
    call_names: dict[str, str] = {}

    def note(name: str, kind: str, ts: Any, origin: str, where: str = "") -> None:
        if name not in state:
            order.append(name)
            state[name] = {"name": name, "state": kind, "last_at": ts, "origin": origin, "dir": "", "read_at": None}
        else:
            state[name].update(state=kind, last_at=ts, origin=origin)
        if where:
            state[name]["dir"] = where
        if kind == FULL:
            state[name]["read_at"] = ts

    for row in rows:
        role = row["role"]
        content = row["content"]
        ts = row["timestamp"]
        if role == "assistant":
            for call_id, name in _tool_call_skills(row):
                call_names[call_id] = name
            continue
        if role == "tool":
            tool_name = row["tool_name"] or ""
            name = call_names.get(str(row["tool_call_id"] or ""), "")
            if tool_name not in SKILL_TOOL_NAMES and not name:
                continue
            kind, where = _tool_row(content)
            if not kind:
                continue
            if name:
                note(name, kind, ts, "skill_view", where)
                continue
            for found in _PRUNED_RE.findall(content if isinstance(content, str) else ""):
                note(found, PRUNED, ts, "compaction")
            continue
        if isinstance(content, str) and content:
            for found in _PRUNED_RE.findall(content):
                note(found, PRUNED, ts, "compaction")
            for name in _scaffold_skills(content):
                note(name, FULL, ts, "scaffold")
    return [state[n] for n in order]


def _resolve_session_ids(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """Candidate ``messages.session_id`` values for a runtime or stored id."""
    candidates = [session_id]
    try:
        row = conn.execute(
            "SELECT session_key FROM sessions WHERE session_key = ? OR session_key LIKE ? LIMIT 1",
            (session_id, f"%{session_id}"),
        ).fetchone()
        if row and row["session_key"]:
            key = str(row["session_key"])
            candidates += [key, key.rsplit(":", 1)[-1]]
    except sqlite3.Error:
        pass
    return list(dict.fromkeys(c for c in candidates if c))


def _fetch_rows(conn: sqlite3.Connection, ids: list[str]) -> list[sqlite3.Row]:
    marks = ",".join("?" for _ in ids)
    sql = (
        "SELECT id, role, content, tool_calls, tool_call_id, tool_name, timestamp, display_kind "
        f"FROM messages WHERE session_id IN ({marks}) AND active = 1 "
        "AND (compacted IS NULL OR compacted = 0) ORDER BY id"
    )
    return list(conn.execute(sql, ids))


def _payload(session_id: str, skills: list[dict], degraded: bool) -> dict:
    loaded = [s for s in skills if s["state"] == FULL]
    return {
        "session_id": session_id,
        "count": len(loaded),
        "skills": skills,
        "loaded": [s["name"] for s in loaded],
        "pruned": [s["name"] for s in skills if s["state"] == PRUNED],
        "generated_at": time.time(),
        "degraded": degraded,
        "source": "transcript" if not degraded else "unavailable",
    }


# ---------------------------------------------------------- skills tree ------

_FM_BLOCK_RE = re.compile(r"\A\ufeff?---[ \t]*\r?\n(.*?)\r?\n---", re.S)
_FM_NAME_RE = re.compile(r"^name:[ \t]*(.+?)[ \t]*$", re.MULTILINE)
_FM_DESC_RE = re.compile(r"^description:[ \t]*(.*)$", re.MULTILINE)
_FM_CAT_RE = re.compile(r"^category:[ \t]*(.+?)[ \t]*$", re.MULTILINE)
_MAX_SKILL_FILES = 5000


def _skill_roots() -> list[Path]:
    """Directories that hold SKILL.md files: this profile's, then the default
    root's, plus the bundled and optional sets shipped with the checkout, plus
    the skill packs that installed plugins ship (``plugins/**/SKILL.md``). On a
    full install those packs are the bulk of the tree, and they were invisible
    to the list and the body route before."""
    homes = [_hermes_home()]
    try:
        from hermes_constants import get_default_hermes_root

        homes.append(Path(get_default_hermes_root()))
    except Exception:
        pass
    candidates: list[Path] = []
    for home in homes:
        home = Path(home)
        candidates += [
            home / "skills",
            home / "hermes-agent" / "skills",
            home / "hermes-agent" / "optional-skills",
            home / "plugins",
        ]
    return [p for p in dict.fromkeys(candidates) if p.is_dir()]


def _unquote(value: str) -> str:
    v = (value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1].strip()
    return v


def _describe(path: Path, root: Path) -> dict | None:
    """``{name, description, category, path}`` from one SKILL.md's frontmatter."""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            text = fh.read(4096)
    except OSError:
        return None
    block = _FM_BLOCK_RE.match(text)
    if not block:
        return None
    body = block.group(1)
    name_match = _FM_NAME_RE.search(body)
    name = _unquote(name_match.group(1)) if name_match else path.parent.name
    if not name:
        return None
    description = ""
    desc_match = _FM_DESC_RE.search(body)
    if desc_match:
        raw = desc_match.group(1).strip()
        if raw in ("|", ">", "|-", ">-", "|+", ">+"):
            lines = []
            for line in body[desc_match.end():].split("\n"):
                if line.strip() and line[:1] not in (" ", "\t"):
                    break
                lines.append(line.strip())
            description = " ".join(l for l in lines if l)
        else:
            description = _unquote(raw)
    cat_match = _FM_CAT_RE.search(body)
    category = _unquote(cat_match.group(1)) if cat_match else ""
    if not category:
        try:
            rel = path.parent.relative_to(root)
            category = rel.parts[0] if len(rel.parts) > 1 else "general"
        except ValueError:
            category = "general"
    return {"name": name, "description": description, "category": category, "path": str(path)}


def scan_skills() -> list[dict]:
    """Every skill SKILL.md on disk, deduped by name (this profile wins)."""
    found: dict[str, dict] = {}
    for root in _skill_roots():
        try:
            files = sorted(root.glob("**/SKILL.md"))
        except OSError:
            continue
        for path in files[:_MAX_SKILL_FILES]:
            info = _describe(path, root)
            if info and info["name"] not in found:
                found[info["name"]] = info
        if len(found) >= _MAX_SKILL_FILES:
            break
    return sorted(found.values(), key=lambda s: (s["category"], s["name"]))


# ---------------------------------------------------------------- routes ----

@router.get("/health")
def health() -> dict:
    return {"ok": bool(_candidate_dbs()), "home": str(_hermes_home()), "stores": [str(p) for p in _candidate_dbs()]}


@router.get("/skills")
def skills(session_id: str = Query("", description="Runtime or stored session id")) -> dict:
    """Loaded / pruned skills for one session. Empty id -> empty list, never an error."""
    if not session_id.strip():
        return _payload("", [], False)
    cache_key = f"{session_id}"
    now = time.monotonic()
    with _lock:
        hit = _cache.get(cache_key)
        if hit and now - hit[0] < _CACHE_TTL:
            return hit[1]
    for db_path in _candidate_dbs():
        try:
            conn = _read_conn(db_path)
            try:
                ids = _resolve_session_ids(conn, session_id)
                rows = _fetch_rows(conn, ids)
            finally:
                conn.close()
        except sqlite3.Error:
            continue
        if rows:
            result = _payload(session_id, analyse(rows), False)
            with _lock:
                _cache[cache_key] = (now, result)
                if len(_cache) > 32:  # bounded: sessions come and go
                    for key in sorted(_cache, key=lambda k: _cache[k][0])[: len(_cache) - 32]:
                        _cache.pop(key, None)
            return result
    # No store knows this session (a brand-new draft, or a session whose rows
    # have not flushed yet): an honest empty list beats a false error.
    return _payload(session_id, [], False)


@router.get("/available")
def available() -> dict:
    """Every skill on disk (name + description + category), from the same roots
    the agent scans. Best-effort enrichment for the pane's "All skills" view;
    the authoritative list still comes from the gateway's ``skills.manage``."""
    key = str(_hermes_home())
    now = time.monotonic()
    with _lock:
        hit = _available_cache.get(key)
        if hit and now - hit[0] < _AVAILABLE_TTL:
            return hit[1]
    skills = scan_skills()
    result = {"skills": skills, "count": len(skills), "generated_at": time.time(), "source": "skills-tree"}
    with _lock:
        _available_cache[key] = (now, result)
    return result


# ------------------------------------------------------------ skill body ----

_MAX_BODY_BYTES = 400_000  # one SKILL.md is a few KB; this is a runaway guard


def split_frontmatter(text: str) -> tuple[str, str]:
    """``(frontmatter block, body)`` — the block without its fence lines.

    No frontmatter, or one this parser cannot see, returns ``("", text)``: the
    whole file is the body and the caller shows no trigger box.
    """
    match = _FM_BLOCK_RE.match(text)
    if not match:
        return "", text
    body = text[match.end():]
    body = body.lstrip(chr(13) + chr(10))  # the blank line after the fence is not content
    return match.group(1), body


def trigger_from_block(block: str) -> str:
    """The ``description`` out of a frontmatter block, folded if it is a block."""
    match = _FM_DESC_RE.search(block or "")
    if not match:
        return ""
    raw = match.group(1).strip()
    if raw in ("|", ">", "|-", ">-", "|+", ">+"):
        lines = []
        for line in block[match.end():].split("\n"):
            if line.strip() and line[:1] not in (" ", "\t"):
                break
            lines.append(line.strip())
        return " ".join(l for l in lines if l)
    return _unquote(raw)


def _recorded_read(name: str, session_id: str) -> tuple[str, Any]:
    """``(skill directory, read time)`` this session recorded for a skill."""
    if not (session_id or "").strip():
        return "", None
    try:
        entries = skills(session_id).get("skills", [])
    except Exception:
        return "", None
    for entry in entries:
        if entry.get("name") == name:
            return str(entry.get("dir") or ""), entry.get("read_at")
    return "", None


@router.get("/body")
def body(
    name: str = Query("", description="Skill name"),
    session_id: str = Query("", description="Runtime or stored session id"),
) -> dict:
    """One skill's text, split from its frontmatter, with where it came from.

    Resolution order: the directory this conversation recorded for that read,
    then the disk scan. The name is the only selector — a path from the client
    is never honoured. No cache: an edited skill must show its new text on the
    next click.
    """
    key = (name or "").strip()
    result = {
        "found": False,
        "name": key,
        "path": "",
        "body": "",
        "trigger": "",
        "frontmatter_raw": "",
        "bytes": 0,
        "truncated": False,
        "modified_at": None,
        "read_at": None,
        "modified_since_read": None,
        "reason": "unknown_name",
    }
    if not key:
        return result

    recorded_dir, read_at = _recorded_read(key, session_id or "")
    path = None
    if recorded_dir:
        candidate = Path(recorded_dir) / "SKILL.md"
        if candidate.is_file():
            path = candidate
    if path is None:
        for entry in available().get("skills", []):
            if entry["name"] == key:
                path = Path(entry["path"])
                break
    if path is None:
        return result

    try:
        raw = path.read_bytes()
        mtime = path.stat().st_mtime
    except OSError:
        return {**result, "reason": "unreadable", "path": str(path)}
    if not raw.strip():
        return {**result, "reason": "empty", "path": str(path)}

    text = raw[:_MAX_BODY_BYTES].decode("utf-8", "replace")
    frontmatter_raw, body_text = split_frontmatter(text)
    modified = None
    if isinstance(read_at, (int, float)) and read_at:
        modified = mtime > float(read_at)
    return {
        "found": True,
        "name": key,
        "path": str(path),
        "body": body_text,
        "trigger": trigger_from_block(frontmatter_raw),
        "frontmatter_raw": frontmatter_raw,
        "bytes": len(raw),
        "truncated": len(raw) > _MAX_BODY_BYTES,
        "modified_at": mtime,
        "read_at": read_at if isinstance(read_at, (int, float)) else None,
        "modified_since_read": modified,
        "reason": "ok",
    }

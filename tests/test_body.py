"""Skill body: frontmatter split, trigger extraction, route resolution, provenance."""
from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from support import load_api, row

API = load_api()

FM = """---
name: alpha
description: Does the alpha thing.
category: tools
---

# Alpha

Body text.
"""

NO_FM = "# just a body\n\nNo frontmatter here.\n"

FOLDED = """---
name: gamma
description: >
  First line of a folded
  description.
---

# Gamma
"""


def write_skill(root: Path, rel: str, text: str) -> Path:
    path = root / rel / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class FrontmatterTests(unittest.TestCase):
    def test_split_removes_block_and_leading_blank(self):
        block, body = API.split_frontmatter(FM)
        self.assertIn("description: Does the alpha thing.", block)
        self.assertNotIn("---", block)
        self.assertTrue(body.startswith("# Alpha"))

    def test_split_without_frontmatter_returns_whole_text(self):
        block, body = API.split_frontmatter(NO_FM)
        self.assertEqual(block, "")
        self.assertEqual(body, NO_FM)

    def test_split_keeps_a_rule_inside_the_body(self):
        text = "---\nname: a\ndescription: d\n---\n\n# A\n\n---\n\ntail\n"
        block, body = API.split_frontmatter(text)
        self.assertIn("name: a", block)
        self.assertIn("---\n\ntail", body)

    def test_trigger_plain_and_folded(self):
        self.assertEqual(API.trigger_from_block("name: a\ndescription: Does it.\n"), "Does it.")
        folded = API.trigger_from_block("name: a\ndescription: >\n  Folded one\n  and two\nother: x\n")
        self.assertEqual(folded, "Folded one and two")

    def test_trigger_absent(self):
        self.assertEqual(API.trigger_from_block("name: a\n"), "")


class BodyRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write_skill(self.root, "alpha", FM)
        write_skill(self.root, "plugins/pack/skills/packed", "---\nname: packed\ndescription: From a pack.\n---\n\npack body\n")
        self.patch = mock.patch.object(API, "_skill_roots", return_value=[self.root])
        self.patch.start()
        API._available_cache.clear()
        API._cache.clear()

    def tearDown(self):
        self.patch.stop()
        API._available_cache.clear()
        API._cache.clear()
        self.tmp.cleanup()

    def test_known_skill_returns_split_text(self):
        out = API.body("alpha", "")
        self.assertTrue(out["found"])
        self.assertEqual(out["reason"], "ok")
        self.assertEqual(out["trigger"], "Does the alpha thing.")
        self.assertIn("# Alpha", out["body"])
        self.assertNotIn("description:", out["body"])
        self.assertIsNone(out["read_at"])
        self.assertIsNone(out["modified_since_read"])

    def test_plugin_pack_skill_resolves(self):
        out = API.body("packed", "")
        self.assertTrue(out["found"], "a skill shipped by a plugin pack must resolve")
        self.assertEqual(out["trigger"], "From a pack.")

    def test_unknown_name(self):
        out = API.body("nope", "")
        self.assertFalse(out["found"])
        self.assertEqual(out["reason"], "unknown_name")

    def test_path_shaped_name_is_not_a_path(self):
        out = API.body("../../etc/passwd", "")
        self.assertFalse(out["found"])
        self.assertEqual(out["reason"], "unknown_name")

    def test_empty_name(self):
        out = API.body("", "")
        self.assertFalse(out["found"])
        self.assertEqual(out["reason"], "unknown_name")

    def test_truncation_flagged(self):
        big = "---\nname: huge\ndescription: big\n---\n\n" + ("x" * (API._MAX_BODY_BYTES + 100))
        write_skill(self.root, "huge", big)
        API._available_cache.clear()
        out = API.body("huge", "")
        self.assertTrue(out["found"])
        self.assertTrue(out["truncated"])

    def test_modified_flag_from_session_read(self):
        path = self.root / "alpha" / "SKILL.md"
        read_at = time.time() - 3600
        os.utime(path, (time.time(), time.time()))
        payload = {"skills": [{"name": "alpha", "state": "full", "dir": str(self.root / "alpha"), "read_at": read_at}]}
        with mock.patch.object(API, "skills", return_value=payload):
            out = API.body("alpha", "sid-1")
        self.assertEqual(out["read_at"], read_at)
        self.assertTrue(out["modified_since_read"])

    def test_recorded_directory_wins_over_scan(self):
        other = self.root / "elsewhere" / "alpha"
        other.mkdir(parents=True)
        (other / "SKILL.md").write_text("---\nname: alpha\ndescription: the other copy\n---\n\nother body\n", encoding="utf-8")
        payload = {"skills": [{"name": "alpha", "state": "full", "dir": str(other), "read_at": None}]}
        with mock.patch.object(API, "skills", return_value=payload):
            out = API.body("alpha", "sid-2")
        self.assertEqual(Path(out["path"]), other / "SKILL.md")


class AnalysisProvenanceTests(unittest.TestCase):
    def _rows(self):
        call = {"id": "c1", "function": {"name": "skill_view", "arguments": json.dumps({"name": "alpha"})}}
        read_result = json.dumps({"success": True, "name": "alpha", "skill_dir": "/home/skills/alpha", "content": "body"})
        prune = "compaction summary: [SKILL_PRUNED: content lost; reload with skill_view(name='alpha')]"
        return [
            row(id=1, role="assistant", content="", tool_calls=json.dumps([call]), timestamp=100.0),
            row(id=2, role="tool", content=read_result, tool_call_id="c1", tool_name="skill_view", timestamp=101.0),
            row(id=3, role="user", content=prune, timestamp=500.0),
        ]

    def test_read_time_survives_a_prune(self):
        entry = API.analyse(self._rows())[0]
        self.assertEqual(entry["state"], "pruned")
        self.assertEqual(entry["read_at"], 101.0, "a prune must not pass itself off as the read")
        self.assertEqual(entry["dir"], "/home/skills/alpha")

    def test_scaffold_load_counts_as_a_read(self):
        text = '[IMPORTANT: The "beta" skill is auto-loaded. Follow its instructions for this session.]'
        entry = API.analyse([row(id=1, role="user", content=text, timestamp=42.0)])[0]
        self.assertEqual(entry["state"], "full")
        self.assertEqual(entry["read_at"], 42.0)
        self.assertEqual(entry["dir"], "")

    def test_linked_file_read_without_directory_is_tolerated(self):
        call = {"id": "c9", "function": {"name": "skill_view", "arguments": json.dumps({"name": "x", "file_path": "ref.md"})}}
        result = json.dumps({"success": True, "name": "x", "content": "linked"})
        rows = [
            row(id=1, role="assistant", content="", tool_calls=json.dumps([call]), timestamp=10.0),
            row(id=2, role="tool", content=result, tool_call_id="c9", tool_name="skill_view", timestamp=11.0),
        ]
        entry = API.analyse(rows)[0]
        self.assertEqual(entry["read_at"], 11.0)
        self.assertEqual(entry["dir"], "")


if __name__ == "__main__":
    unittest.main()

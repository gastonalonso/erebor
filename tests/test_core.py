import unittest
from datetime import datetime, timezone

import core

NOW = datetime(2026, 11, 2, 18, 0, tzinfo=timezone.utc)
WINDOW = {"initial_days": 3, "max_days": 7, "override_days": None}
CATALOG = {
    "fellow": {"tools": ["fellow_read"], "instructions": "Fellow rules."},
    "slack": {"tools": [], "instructions": "Slack rules."},
}
PLANNED = {
    "fellow": {"since": "2026-11-01T00:00:00Z", "options": {}},
    "linear": {"since": "2026-11-01T00:00:00Z", "options": {}},
}
CLEAN_EXIT = {"exit_code": 0, "failure": None, "claude": {}}


def result_with(**sources):
    return {"runId": "r1", "sources": sources, "summary": "Did things."}


class ComputeSinceTest(unittest.TestCase):
    def test_first_run_uses_initial_lookback(self):
        since = core.compute_since(None, NOW, WINDOW)
        self.assertEqual(since, "2026-10-30T18:00:00Z")

    def test_cursor_is_rewound_by_the_overlap(self):
        since = core.compute_since("2026-11-02T12:00:00Z", NOW, WINDOW)
        self.assertEqual(since, "2026-11-02T11:00:00Z")

    def test_stale_cursor_is_capped_at_max_lookback(self):
        since = core.compute_since("2026-09-01T00:00:00Z", NOW, WINDOW)
        self.assertEqual(since, "2026-10-26T18:00:00Z")

    def test_override_ignores_cursor_and_cap(self):
        window = {**WINDOW, "override_days": 30}
        since = core.compute_since("2026-11-02T12:00:00Z", NOW, window)
        self.assertEqual(since, "2026-10-03T18:00:00Z")


class AllowedToolsTest(unittest.TestCase):
    def test_edits_are_confined_to_the_vault(self):
        tools = core.allowed_tools("/v", ["fellow"], CATALOG)
        self.assertIn("Edit(//v/**)", tools)

    def test_includes_the_source_tools(self):
        tools = core.allowed_tools("/v", ["fellow"], CATALOG)
        self.assertIn("fellow_read", tools)

    def test_unknown_source_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown source"):
            core.allowed_tools("/v", ["jira"], CATALOG)

    def test_source_without_tools_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "no tools"):
            core.allowed_tools("/v", ["slack"], CATALOG)


class DisallowedToolsTest(unittest.TestCase):
    def test_shell_is_blocked_without_shell_sources(self):
        self.assertIn("Bash", core.disallowed_tools("/v", ["Read"]))

    def test_shell_stays_for_sources_that_need_commands(self):
        tools = ["Read", "Bash(gh pr view:*)"]
        self.assertNotIn("Bash", core.disallowed_tools("/v", tools))

    def test_settings_plugins_and_dashboards_are_read_only(self):
        blocked = core.disallowed_tools("/v", ["Read"])
        for folder in (".claude", ".obsidian", "dashboards"):
            self.assertIn(f"Edit(//v/{folder}/**)", blocked)

    def test_generated_index_is_read_only(self):
        blocked = core.disallowed_tools("/v", ["Read"])
        self.assertIn("Edit(//v/index/**)", blocked)


class NeutralizeScriptsTest(unittest.TestCase):
    def test_fenced_dataviewjs_becomes_plain_text(self):
        text = "a\n```dataviewjs\nalert(1)\n```\n"
        self.assertEqual(
            core.neutralize_scripts(text), "a\n```text\nalert(1)\n```\n"
        )

    def test_inline_javascript_query_is_broken(self):
        self.assertEqual(
            core.neutralize_scripts("x `$= alert(1)` y"), "x `$ = alert(1)` y"
        )

    def test_plain_dataview_queries_are_left_alone(self):
        text = "```dataview\nLIST\n```\n"
        self.assertEqual(core.neutralize_scripts(text), text)


class RenderTest(unittest.TestCase):
    def test_placeholders_are_replaced_everywhere(self):
        rendered = core.render_prompt("@@A@@ and @@A@@", {"A": "x"})
        self.assertEqual(rendered, "x and x")

    def test_sources_section_carries_since_and_instructions(self):
        planned = {"fellow": PLANNED["fellow"]}
        rendered = core.render_sources(planned, CATALOG)
        self.assertIn("2026-11-01T00:00:00Z", rendered)
        self.assertIn("Fellow rules.", rendered)

    def test_slugify(self):
        self.assertEqual(
            core.slugify("  Checkout v2: Redesign! "), "checkout-v2-redesign"
        )


class SummarizeRunTest(unittest.TestCase):
    def test_all_sources_ok_is_ok(self):
        result = result_with(fellow={"ok": True}, linear={"ok": True})
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(summary["status"], "ok")

    def test_one_failed_source_is_partial(self):
        result = result_with(
            fellow={"ok": True}, linear={"ok": False, "error": "auth"}
        )
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(summary["status"], "partial")

    def test_source_that_reports_a_problem_makes_the_run_partial(self):
        result = result_with(
            fellow={"ok": True}, linear={"ok": True, "error": "half read"}
        )
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(summary["status"], "partial")

    def test_run_is_partial_when_every_source_reports_a_problem(self):
        half_read = {"ok": True, "error": "half read"}
        result = result_with(fellow=half_read, linear=half_read)
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(summary["status"], "partial")

    def test_source_that_reports_a_problem_has_not_succeeded(self):
        result = result_with(
            fellow={"ok": True}, linear={"ok": True, "error": "half read"}
        )
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(core.succeeded_sources(summary), ["fellow"])

    def test_report_shows_the_problem_of_a_source_marked_ok(self):
        result = result_with(
            fellow={"ok": True}, linear={"ok": True, "error": "half read"}
        )
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertIn(
            "⚠ linear  0 seen, 0 written, 0 updated · half read",
            core.format_report(summary),
        )

    def test_unreported_source_counts_as_failed(self):
        result = result_with(fellow={"ok": True})
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(
            summary["sources"]["linear"]["error"], core.NOT_REPORTED
        )

    def test_nonzero_exit_downgrades_ok_to_partial(self):
        result = result_with(fellow={"ok": True}, linear={"ok": True})
        outcome = {**CLEAN_EXIT, "exit_code": 1}
        summary = core.summarize_run(PLANNED, result, outcome)
        self.assertEqual(summary["status"], "partial")

    def test_missing_result_is_failed_with_reason(self):
        outcome = {**CLEAN_EXIT, "failure": "boom"}
        summary = core.summarize_run(PLANNED, None, outcome)
        self.assertEqual(
            (summary["status"], summary["error"]), ("failed", "boom")
        )

    def test_since_is_kept_per_source(self):
        summary = core.summarize_run(PLANNED, None, CLEAN_EXIT)
        self.assertEqual(
            summary["sources"]["fellow"]["since"], "2026-11-01T00:00:00Z"
        )

    def test_succeeded_sources_lists_only_ok(self):
        result = result_with(fellow={"ok": True}, linear={"ok": False})
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(core.succeeded_sources(summary), ["fellow"])

    def test_areas_updated_are_carried_into_the_summary(self):
        result = {**result_with(fellow={"ok": True}), "areas_updated": ["a"]}
        summary = core.summarize_run(PLANNED, result, CLEAN_EXIT)
        self.assertEqual(summary["areasUpdated"], ["a"])

    def test_report_points_at_lint_when_it_has_entries(self):
        summary = core.summarize_run(PLANNED, None, CLEAN_EXIT)
        report = core.format_report({**summary, "lintEntries": 4})
        self.assertIn("4 entries to tidy in index/lint.md", report)

    def test_report_is_quiet_about_an_empty_lint(self):
        summary = core.summarize_run(PLANNED, None, CLEAN_EXIT)
        report = core.format_report({**summary, "lintEntries": 0})
        self.assertNotIn("lint", report)

    def test_result_for_another_run_is_rejected(self):
        self.assertFalse(core.is_result_for_run({"runId": "old"}, "new"))


UPKEEP = {
    "topics": ["checkout"],
    "ok": True,
    "claude": {"total_cost_usd": 0.5, "usage": {"output_tokens": 7}},
}


class MergeUpkeepTest(unittest.TestCase):
    def summary(self, **outcome):
        result = result_with(fellow={"ok": True}, linear={"ok": True})
        claude = {"total_cost_usd": 1.0, "usage": {"output_tokens": 3}}
        outcome = {**CLEAN_EXIT, "claude": claude, **outcome}
        return core.summarize_run(PLANNED, result, outcome)

    def test_upkeep_cost_is_added_to_the_run(self):
        merged = core.merge_upkeep(self.summary(), UPKEEP)
        self.assertEqual(merged["costUsd"], 1.5)

    def test_upkeep_tokens_are_added_to_the_run(self):
        merged = core.merge_upkeep(self.summary(), UPKEEP)
        self.assertEqual(merged["tokens"]["output"], 10)

    def test_failed_upkeep_downgrades_ok_to_partial(self):
        merged = core.merge_upkeep(self.summary(), {**UPKEEP, "ok": False})
        self.assertEqual(merged["status"], "partial")

    def test_failed_upkeep_leaves_a_failed_run_failed(self):
        failed = self.summary(failure="boom")
        merged = core.merge_upkeep(failed, {**UPKEEP, "ok": False})
        self.assertEqual(merged["status"], "failed")

    def test_report_names_the_topics_upkeep_worked_on(self):
        merged = core.merge_upkeep(self.summary(), UPKEEP)
        self.assertIn("✓ upkeep  checkout", core.format_report(merged))


USAGE_EVENT = {
    "total_cost_usd": 1.0629942,
    "usage": {
        "input_tokens": 38,
        "cache_creation_input_tokens": 159953,
        "cache_read_input_tokens": 2308862,
        "output_tokens": 19222,
    },
}


class UsageTest(unittest.TestCase):
    def test_input_tokens_include_cache_reads_and_writes(self):
        outcome = {**CLEAN_EXIT, "claude": USAGE_EVENT}
        summary = core.summarize_run(PLANNED, None, outcome)
        self.assertEqual(
            summary["tokens"],
            {"input": 2468853, "cached": 2308862, "output": 19222},
        )

    def test_report_shows_cost_and_tokens(self):
        outcome = {**CLEAN_EXIT, "claude": USAGE_EVENT}
        summary = core.summarize_run(PLANNED, None, outcome)
        self.assertIn(
            "cost: $1.06 · 2.47M tokens in (2.31M cached), 19.2K out",
            core.format_report(summary),
        )

    def test_report_omits_cost_when_claude_reported_none(self):
        summary = core.summarize_run(PLANNED, None, CLEAN_EXIT)
        self.assertNotIn("cost:", core.format_report(summary))


if __name__ == "__main__":
    unittest.main()

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import ingest
import skill

FAKE_CLAUDE = Path(__file__).with_name("fake_claude.py")
GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


class ConfiguredTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.vault = self.tmp / "vault"
        self.state = self.vault / ".state"
        config = {
            "vault": str(self.vault),
            "claude_bin": str(FAKE_CLAUDE),
            "seed_topics": ["Checkout Redesign"],
            "sources": {
                "fellow": {"enabled": True},
                "linear": {"enabled": True},
            },
        }
        config_file = self.tmp / "config.json"
        config_file.write_text(json.dumps(config))
        env = {**GIT_IDENTITY, "EREBOR_CONFIG": str(config_file)}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_ingest(self, *args, mode="ok"):
        with (
            mock.patch.dict(os.environ, {"FAKE_CLAUDE_MODE": mode}),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            return ingest.main(list(args))

    def read_state(self, name):
        return json.loads((self.state / name).read_text())


class IngestRunTest(ConfiguredTestCase):
    def test_successful_run_reports_ok(self):
        self.assertEqual(self.run_ingest(), ingest.EXIT_OK)
        self.assertEqual(self.read_state("last-run.json")["status"], "ok")

    def test_successful_run_advances_every_cursor(self):
        self.run_ingest()
        self.assertEqual(
            set(self.read_state("cursor.json")), {"fellow", "linear"}
        )

    def test_successful_run_commits_the_vault(self):
        self.run_ingest()
        self.assertIsNotNone(self.read_state("last-run.json")["commit"])

    def test_partial_run_advances_only_succeeded_cursors(self):
        exit_code = self.run_ingest(mode="partial")
        self.assertEqual(exit_code, ingest.EXIT_PARTIAL)
        self.assertEqual(list(self.read_state("cursor.json")), ["fellow"])

    def test_source_that_reports_a_problem_keeps_its_cursor(self):
        self.run_ingest(mode="caveat")
        self.assertEqual(list(self.read_state("cursor.json")), ["fellow"])

    def test_source_that_reports_a_problem_makes_the_run_partial(self):
        exit_code = self.run_ingest(mode="caveat")
        self.assertEqual(exit_code, ingest.EXIT_PARTIAL)

    def test_run_without_result_file_fails_and_keeps_cursors(self):
        exit_code = self.run_ingest(mode="silent")
        last_run = self.read_state("last-run.json")
        self.assertEqual(exit_code, ingest.EXIT_FAILED)
        self.assertIn("result file", last_run["error"])
        self.assertEqual(self.read_state("cursor.json"), {})

    def test_each_run_appends_to_history(self):
        self.run_ingest()
        self.run_ingest()
        history = (self.state / "history.jsonl").read_text().splitlines()
        self.assertEqual(len(history), 2)

    def test_concurrent_run_is_refused(self):
        lock = self.state / "run.lock"
        self.run_ingest("--init")
        lock.mkdir(parents=True)
        (lock / "pid").write_text(str(os.getpid()))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.run_ingest(), ingest.EXIT_LOCKED)

    def test_dry_run_leaves_no_state(self):
        self.run_ingest("--dry-run")
        self.assertFalse((self.state / "last-run.json").exists())

    def test_script_blocks_written_by_claude_are_neutralized(self):
        self.run_ingest(mode="script")
        note = self.vault / "sources/fellow/2026-11-02-eng-sync.md"
        self.assertNotIn("dataviewjs", note.read_text())

    def test_neutralized_scripts_make_the_run_partial(self):
        self.assertEqual(self.run_ingest(mode="script"), ingest.EXIT_PARTIAL)

    def test_claude_starts_with_a_fresh_index(self):
        self.run_ingest()
        self.assertIn(
            "Saw the index", self.read_state("last-run.json")["summary"]
        )

    def test_index_covers_notes_written_during_the_run(self):
        self.run_ingest()
        lint = (self.vault / "index/lint.md").read_text()
        self.assertIn("[[2026-11-02-eng-sync]]", lint)

    def test_run_reports_how_much_there_is_to_tidy(self):
        self.run_ingest()
        self.assertGreater(self.read_state("last-run.json")["lintEntries"], 0)

    def test_index_flag_rebuilds_without_running_claude(self):
        self.assertEqual(self.run_ingest("--index"), ingest.EXIT_OK)
        index = (self.vault / "index/map.md").read_text()
        self.assertIn("[[checkout-redesign]]", index)
        self.assertFalse((self.state / "last-run.json").exists())

    def test_init_builds_the_index(self):
        self.run_ingest("--init")
        self.assertTrue((self.vault / "index/map.md").exists())

    def test_init_seeds_topics_as_active_notes_with_a_description(self):
        self.run_ingest("--init")
        note = (self.vault / "topics/checkout-redesign.md").read_text()
        self.assertIn('status: active\ndescription: "Checkout Redesign"', note)


class UpkeepTest(ConfiguredTestCase):
    def upkeep_prompt(self):
        prompts = list((self.state / "logs").glob("*.upkeep.prompt.md"))
        return prompts[0].read_text() if prompts else None

    def mark_seed_topic_promoted(self):
        self.run_ingest("--init")
        note = self.vault / "topics/checkout-redesign.md"
        text = note.read_text().replace(
            "status:", "promoted: 2099-01-01\nstatus:"
        )
        note.write_text(text)

    def test_upkeep_pass_is_told_which_topics_to_promote(self):
        self.run_ingest()
        self.assertIn("[[checkout-redesign]]", self.upkeep_prompt())

    def test_what_upkeep_writes_is_indexed(self):
        self.run_ingest()
        index = (self.vault / "index/map.md").read_text()
        self.assertIn("[[from-upkeep]]", index)

    def test_upkeep_cost_counts_toward_the_run(self):
        self.run_ingest()
        cost = self.read_state("last-run.json")["costUsd"]
        self.assertAlmostEqual(cost, 0.03)

    def test_failed_upkeep_makes_the_run_partial(self):
        exit_code = self.run_ingest(mode="upkeep-fails")
        self.assertEqual(exit_code, ingest.EXIT_PARTIAL)

    def test_no_upkeep_pass_when_every_topic_is_promoted(self):
        self.mark_seed_topic_promoted()
        self.run_ingest()
        self.assertIsNone(self.upkeep_prompt())

    def test_no_upkeep_pass_after_a_run_without_a_result(self):
        self.run_ingest(mode="silent")
        self.assertIsNone(self.upkeep_prompt())

    def test_upkeep_flag_runs_the_pass_without_fetching_sources(self):
        self.assertEqual(self.run_ingest("--upkeep"), ingest.EXIT_OK)
        self.assertIsNotNone(self.upkeep_prompt())
        self.assertFalse((self.state / "cursor.json").exists())

    def test_upkeep_flag_commits_what_the_pass_wrote(self):
        self.run_ingest("--upkeep")
        status = ingest.vault_files.git(self.vault, "status", "--porcelain")
        self.assertEqual(status, "")

    def test_upkeep_flag_reports_a_failed_pass(self):
        exit_code = self.run_ingest("--upkeep", mode="upkeep-fails")
        self.assertEqual(exit_code, ingest.EXIT_FAILED)


class InstallSkillTest(ConfiguredTestCase):
    def install(self, skills_home):
        with mock.patch.object(skill, "SKILLS_HOME", skills_home):
            return self.run_ingest("--install-skill")

    def test_installed_skill_points_at_the_vault(self):
        self.install(self.tmp / "skills")
        skill = (self.tmp / "skills/knowledge-vault/SKILL.md").read_text()
        self.assertIn(f"The vault at `{self.vault}`", skill)

    def test_reinstalling_excludes_the_skill_from_a_host_repo_once(self):
        host = self.tmp / "host"
        host.mkdir()
        ingest.vault_files.git(host, "init", "-q")
        self.install(host / "skills")
        self.install(host / "skills")
        exclude = (host / ".git/info/exclude").read_text().splitlines()
        self.assertEqual(exclude.count("/skills/knowledge-vault/"), 1)


class ClaudeCommandTest(unittest.TestCase):
    def test_user_settings_cannot_widen_permissions(self):
        command = ingest.claude_command(
            {"claude_bin": "claude"}, "/v", ["Read"]
        )
        index = command.index("--setting-sources")
        self.assertEqual(command[index + 1], "project")


if __name__ == "__main__":
    unittest.main()

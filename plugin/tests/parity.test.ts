/** Checks the plugin against the script engine: same bytes, same state. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  formatReport,
  neutralizeScripts,
  succeededSources,
  summarizeRun,
} from '../src/core.ts';
import { ingest } from '../src/ingest.ts';
import { claudeCommand, planRun } from '../src/plan.ts';
import { queue, upkeepPrompt } from '../src/upkeep.ts';
import { build } from '../src/vault-index.ts';
import { load } from '../src/vault-notes.ts';
import { FIXTURE_VAULT } from './fixture-vault.ts';
import {
  REPO,
  python,
  readState,
  runScript,
  scaffold,
  tempDir,
  writeFiles,
} from './helpers.ts';

const INDEX_FILES = ['map.md', 'knowledge.md', 'tickets.md', 'lint.md'];
const SCRIPT_INDEX = `
import json, sys
from pathlib import Path
import core, vault_index, vault_notes
files = vault_index.build(vault_notes.load(Path(json.load(sys.stdin))))
print(json.dumps({n: core.neutralize_scripts(t) for n, t in files.items()}))
`;
const SCRIPT_NEUTRALIZE = `
import json, sys
import core
print(json.dumps([core.neutralize_scripts(t) for t in json.load(sys.stdin)]))
`;
const SCRIPT_PROMPT = `
import json, sys
import ingest
args = json.load(sys.stdin)
catalog = json.loads(ingest.SOURCES_FILE.read_text())
print(json.dumps(ingest.build_prompt(
    args["planned"], catalog, args["run_values"], args["exclusions"])))
`;
const SCRIPT_OPTIONS = `
import json, sys
import ingest
config = json.load(sys.stdin)
planned = ingest.plan_sources(config, list(config["sources"]), {}, None)
print(json.dumps({name: plan["options"] for name, plan in planned.items()}))
`;
const SCRIPT_COMMAND = `
import json, sys
import core, ingest
config = json.load(sys.stdin)
catalog = json.loads(ingest.SOURCES_FILE.read_text())
tools = core.allowed_tools(config["vault"], list(config["sources"]), catalog)
print(json.dumps(ingest.claude_command(config, config["vault"], tools)))
`;
const SCRIPT_UPKEEP_PROMPT = `
import json, sys
from pathlib import Path
import core, upkeep
args = json.load(sys.stdin)
topics = upkeep.queue(Path(args["vault"]))
print(json.dumps(core.render_prompt(upkeep.PROMPT_TEMPLATE.read_text(), {
    "RUN_ID": args["runId"], "VAULT": args["vault"], "TODAY": args["today"],
    "TOPICS": "\\n".join(upkeep._topic_line(topic) for topic in topics)})))
`;
const SCRIPT_OUTCOME = `
import json, sys
import core
args = json.load(sys.stdin)
outcome = {"exit_code": args["exitCode"], "failure": args["failure"],
           "claude": args["claude"]}
summary = core.summarize_run(args["planned"], args["result"], outcome)
print(json.dumps({"summary": summary, "report": core.format_report(summary),
                  "advanced": core.succeeded_sources(summary)}))
`;
const PLANNED = {
  fellow: { since: '2026-11-01T00:00:00Z', options: {} },
  github: { since: '2026-11-01T00:00:00Z', options: {} },
};
const USAGE = {
  total_cost_usd: 1.0629942,
  usage: { input_tokens: 38, cache_read_input_tokens: 2308862 },
  permission_denials: [{}],
};
const SEEN = { ok: true, items_seen: 3, notes_written: 2 };
const OUTCOMES = {
  'every source ok': { sources: { fellow: SEEN, github: SEEN } },
  'a source that failed': {
    sources: { fellow: SEEN, github: { ok: false, error: 'not signed in' } },
  },
  'a source marked ok that reports a problem': {
    sources: { fellow: SEEN, github: { ...SEEN, error: 'two repos not read' } },
  },
  'a source Claude left out': { sources: { fellow: SEEN } },
  'no result file': null,
};
const SOURCES = {
  fellow: { enabled: true, skip_one_on_ones: false },
  linear: { enabled: true, teams: [] },
  slack: { enabled: false, include_dms: true, channels: ['#général'] },
  calendar: { enabled: true, days_ahead: 14 },
  github: { enabled: true, repos: ['example-org/app', 'example-org/web'] },
};
const SCRIPT_FENCES = [
  'a\n```dataviewjs\nalert(1)\n```\n',
  '  ~~~~ dataviewjs\n',
  '```dataviewjsé\n',
  '\n\n\t```dataviewjs',
  'inline `$= 1` twice `$= 2`',
  'not at a line start ```dataviewjs',
];

function pluginIndex(vault: string): Record<string, string> {
  const files = build(load(vault));
  const safe = Object.entries(files).map(([name, text]) => [
    name,
    neutralizeScripts(text),
  ]);
  return Object.fromEntries(safe);
}

function scriptIndex(vault: string): Record<string, string> {
  return python(SCRIPT_INDEX, vault);
}

describe('the index of a vault full of edge cases', () => {
  for (const name of INDEX_FILES) {
    it(`has the same ${name} from both engines`, (t) => {
      const vault = tempDir(t);
      writeFiles(vault, FIXTURE_VAULT);
      assert.equal(pluginIndex(vault)[name], scriptIndex(vault)[name]);
    });
  }
});

// Set EREBOR_PARITY_VAULT to a real vault to compare the engines on it. Read-only.
const liveVault = process.env.EREBOR_PARITY_VAULT?.replace(/^~/, homedir());

describe('the index of a real vault', { skip: !liveVault }, () => {
  for (const name of INDEX_FILES) {
    it(`has the same ${name} from both engines`, () => {
      const vault = liveVault ?? '';
      assert.equal(pluginIndex(vault)[name], scriptIndex(vault)[name]);
    });
  }
});

describe('what Claude is given', () => {
  it('is the same prompt from both engines', (t) => {
    const { setup } = scaffold(t, SOURCES);
    setup.config.exclusions = ['HR matters', 'Costs in $& form'];
    const now = new Date();
    const plan = planRun(setup, {}, now);
    const scriptPrompt = python(SCRIPT_PROMPT, {
      planned: plan.planned,
      exclusions: setup.config.exclusions,
      run_values: {
        RUN_ID: plan.runId,
        VAULT: setup.config.vault,
        NOW: plan.startedAt,
        RESULT_FILE: join(setup.config.vault, '.state/run-result.json'),
      },
    });
    assert.equal(plan.prompt, scriptPrompt);
  });

  it('carries the same options for each source', (t) => {
    const { setup } = scaffold(t, SOURCES);
    const names = Object.keys(SOURCES);
    const { planned } = planRun(setup, { sources: names });
    const options = Object.fromEntries(
      names.map((name) => [name, planned[name].options]),
    );
    assert.deepEqual(options, python(SCRIPT_OPTIONS, setup.config));
  });

  it('is the same command line from both engines', (t) => {
    const { setup } = scaffold(t, SOURCES);
    const config = { ...setup.config, claude_bin: 'claude', model: 'sonnet' };
    const { tools } = planRun(setup, { sources: Object.keys(SOURCES) });
    assert.deepEqual(
      claudeCommand(config, tools),
      python(SCRIPT_COMMAND, config),
    );
  });

  it('is the same upkeep prompt from both engines', (t) => {
    const vault = tempDir(t);
    writeFiles(vault, FIXTURE_VAULT);
    const job = {
      template: readFileSync(join(REPO, 'upkeep.md'), 'utf8'),
      runId: '2026-11-18T135816',
      today: '2026-11-18',
      vault,
      command: [],
      logDir: '',
    };
    assert.equal(
      upkeepPrompt(job, queue(vault)),
      python(SCRIPT_UPKEEP_PROMPT, job),
    );
  });
});

describe('the outcome of a run', () => {
  for (const [name, reported] of Object.entries(OUTCOMES)) {
    it(`is judged the same by both engines for ${name}`, () => {
      const result = reported && { runId: 'r1', summary: 'Done.', ...reported };
      const failure = reported ? null : 'Claude exited 1 without a result';
      const outcome = { exitCode: reported ? 0 : 1, failure, claude: USAGE };
      const summary = summarizeRun(PLANNED, result, outcome);
      const judged = {
        summary,
        report: formatReport(summary),
        advanced: succeededSources(summary),
      };
      const args = { planned: PLANNED, result, ...outcome };
      assert.deepEqual(judged, python(SCRIPT_OUTCOME, args));
    });
  }
});

describe('script blocks', () => {
  it('are neutralized the same way by both engines', () => {
    assert.deepEqual(
      SCRIPT_FENCES.map(neutralizeScripts),
      python(SCRIPT_NEUTRALIZE, SCRIPT_FENCES),
    );
  });
});

describe('one vault, both engines', () => {
  it('lets the script run after the plugin', async (t) => {
    const { setup, configFile } = scaffold(t);
    await ingest(setup);
    assert.equal(runScript(configFile), 0);
  });

  it('lets the plugin run after the script', async (t) => {
    const { setup, configFile } = scaffold(t);
    runScript(configFile);
    assert.equal((await ingest(setup)).status, 'ok');
  });

  it('starts the plugin from the cursor the script left', async (t) => {
    const { setup, state, configFile } = scaffold(t);
    runScript(configFile);
    const scriptCursor = Date.parse(readState(state, 'cursor.json').fellow);
    const lastRun = await ingest(setup);
    const since = Date.parse(lastRun.sources.fellow.since ?? '');
    assert.equal(scriptCursor - since, 3_600_000);
  });

  it('keeps one history across both engines', async (t) => {
    const { setup, state, configFile } = scaffold(t);
    runScript(configFile);
    await ingest(setup);
    const history = readFileSync(join(state, 'history.jsonl'), 'utf8');
    const engines = history
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).engine ?? 'script');
    assert.deepEqual(engines, ['script', 'plugin']);
  });
});

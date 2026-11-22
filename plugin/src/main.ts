/** The Obsidian shell around the ingest engine: commands and a status bar. */

import { mkdirSync, realpathSync, watch } from 'node:fs';
import { join } from 'node:path';

import {
  type App,
  FileSystemAdapter,
  FuzzySuggestModal,
  Notice,
  Plugin,
  type TAbstractFile,
  debounce,
} from 'obsidian';

import { UsageError, formatReport } from './core.ts';
import { ingest, upkeepOnly } from './ingest.ts';
import { isInNoteFolder, refreshIndex } from './live-index.ts';
import { type RunOptions, type Setup, loadSetup } from './plan.ts';
import type { RunHooks } from './runner.ts';
import { type RunStatus, statusText } from './status.ts';
import type { UpkeepRun } from './types.ts';
import {
  LockedError,
  lockHolder,
  readJson,
  releaseOwnLock,
} from './vault-files.ts';
import { rebuild } from './vault-index.ts';

// The checkout this plugin was built from, set by build.mjs. During the trial
// it reads config.json, the prompts and sources.json there, as run.sh does.
declare const REPO_DIR: string;

const SINCE_LAST_RUN = 'Since the last run';
const LOOKBACKS = new Map([
  ['1 day', 1],
  ['2 days', 2],
  ['3 days', 3],
  ['5 days', 5],
  ['7 days', 7],
  ['14 days', 14],
]);
const NOTICE_MS = 15_000;
// Long enough that a pause in typing doesn't set off a rebuild mid-thought.
const INDEX_DELAY_MS = 5_000;

type Job = (setup: Setup, hooks: RunHooks) => Promise<string>;

interface Choice {
  placeholder: string;
  items: string[];
  choose: (item: string) => void;
}

class Picker extends FuzzySuggestModal<string> {
  private readonly items: string[];
  private readonly choose: (item: string) => void;

  constructor(app: App, choice: Choice) {
    super(app);
    this.items = choice.items;
    this.choose = choice.choose;
    this.setPlaceholder(choice.placeholder);
  }

  getItems(): string[] {
    return this.items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.choose(item);
  }
}

function upkeepReport(outcome: UpkeepRun | null): string {
  if (outcome === null) return 'No topic needs promoting.';
  const verdict = outcome.ok ? 'done' : 'failed';
  return `Upkeep ${verdict}: ${outcome.topics.join(', ')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class KnowledgeIngestPlugin extends Plugin {
  private statusBar: HTMLElement | null = null;
  private running: AbortController | null = null;
  private activity = '';

  onload(): void {
    this.statusBar = this.addStatusBarItem();
    this.addCommand({
      id: 'run',
      name: 'Run ingest',
      callback: () => this.runIngest(),
    });
    this.addCommand({
      id: 'run-source',
      name: 'Run ingest for one source',
      callback: () => this.report(() => this.pickSource()),
    });
    this.addCommand({
      id: 'run-lookback',
      name: 'Run ingest with a lookback',
      callback: () => this.pickLookback(),
    });
    this.addCommand({
      id: 'upkeep',
      name: 'Run upkeep',
      callback: () =>
        this.start(async (setup, hooks) =>
          upkeepReport(await upkeepOnly(setup, hooks)),
        ),
    });
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild index',
      callback: () =>
        this.report(() => {
          const entries = rebuild(this.vaultPath());
          return `Index rebuilt: ${entries} entries in index/lint.md`;
        }),
    });
    this.addCommand({
      id: 'cancel',
      name: 'Cancel run',
      checkCallback: (isChecking) => {
        if (!isChecking) this.running?.abort();
        return this.running !== null;
      },
    });
    // A run can't outlive the window: its last steps happen in this process.
    this.registerDomEvent(window, 'beforeunload', () => this.running?.abort());
    // No run has started yet, so a lock with this pid is a reload's leftover.
    releaseOwnLock(join(this.vaultPath(), '.state/run.lock'));
    this.watchState();
    this.watchNotes();
  }

  onunload(): void {
    this.running?.abort();
  }

  private vaultPath(): string {
    const { adapter } = this.app.vault;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new UsageError('Erebor needs a vault on disk.');
    }
    return adapter.getBasePath();
  }

  private setup(): Setup {
    const setup = loadSetup(REPO_DIR);
    const configured = realpathSync(setup.config.vault);
    if (configured !== realpathSync(this.vaultPath())) {
      throw new UsageError(
        `config.json points at ${setup.config.vault}, not at this vault.`,
      );
    }
    return setup;
  }

  /** Show the text `work` returns, or why it failed, as a notice. */
  private async report(work: () => unknown): Promise<void> {
    try {
      const message = await work();
      if (typeof message === 'string') new Notice(message, NOTICE_MS);
    } catch (error) {
      new Notice(`Ingest: ${describe(error)}`, NOTICE_MS);
      const isExpected =
        error instanceof UsageError || error instanceof LockedError;
      if (!isExpected) console.error('erebor', error);
    }
  }

  private async start(job: Job): Promise<void> {
    if (this.running) {
      new Notice('An ingest run is already in progress.');
      return;
    }
    const running = new AbortController();
    this.running = running;
    const onProgress = (toolName: string) => {
      this.activity = toolName;
      this.renderStatus();
    };
    const hooks = { signal: running.signal, onProgress };
    await this.report(() => job(this.setup(), hooks));
    this.running = null;
    this.activity = '';
    this.renderStatus();
  }

  private runIngest(options: RunOptions = {}): Promise<void> {
    return this.start(async (setup, hooks) => {
      const lastRun = await ingest(setup, { ...options, ...hooks });
      return formatReport(lastRun).trim();
    });
  }

  private pickSource(): void {
    const windows = [SINCE_LAST_RUN, ...LOOKBACKS.keys()];
    new Picker(this.app, {
      placeholder: 'Which source?',
      items: Object.keys(this.setup().config.sources),
      choose: (source) => this.pickLookback(windows, [source]),
    }).open();
  }

  private pickLookback(windows = [...LOOKBACKS.keys()], sources?: string[]) {
    new Picker(this.app, {
      placeholder: 'How far back?',
      items: windows,
      choose: (window) =>
        this.runIngest({ sources, lookbackDays: LOOKBACKS.get(window) }),
    }).open();
  }

  private renderStatus(): void {
    const state = join(this.vaultPath(), '.state');
    const lastRun = readJson<RunStatus | null>(
      join(state, 'last-run.json'),
      null,
    );
    const isLocked = lockHolder(join(state, 'run.lock')) !== null;
    this.statusBar?.setText(statusText(lastRun, isLocked, this.activity));
  }

  private refreshIndex(): void {
    try {
      refreshIndex(this.vaultPath());
    } catch (error) {
      console.error('erebor: index rebuild failed', error);
    }
  }

  /** Rebuild the index a little after the notes it is built from change. */
  private watchNotes(): void {
    const refresh = debounce(() => this.refreshIndex(), INDEX_DELAY_MS, true);
    const onChange = (file: TAbstractFile, oldPath = '') => {
      if (isInNoteFolder(file.path) || isInNoteFolder(oldPath)) refresh();
    };
    const { vault, workspace } = this.app;
    // Before the layout is ready Obsidian reports every file as created.
    workspace.onLayoutReady(() => {
      this.registerEvent(vault.on('create', onChange));
      this.registerEvent(vault.on('modify', onChange));
      this.registerEvent(vault.on('delete', onChange));
      this.registerEvent(vault.on('rename', onChange));
      refresh();
    });
    this.register(() => refresh.cancel());
  }

  // The script engine writes the same files, so its runs show up here too.
  private watchState(): void {
    const state = join(this.vaultPath(), '.state');
    mkdirSync(state, { recursive: true });
    const watcher = watch(state, () => this.renderStatus());
    this.register(() => watcher.close());
    this.renderStatus();
  }
}

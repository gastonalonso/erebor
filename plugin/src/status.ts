/** What the status bar says about the last run. */

export interface RunStatus {
  runId?: string;
  status?: string;
  costUsd?: number | null;
}

const NEVER_RUN = 'Ingest: not run yet';
const RUN_ID_PARTS = /^\d{4}-(\d{2}-\d{2})T(\d{2})(\d{2})/;

// A run id is its local start time, such as 2026-11-18T135816.
function startedAt(runId = ''): string {
  const parts = RUN_ID_PARTS.exec(runId);
  return parts ? `${parts[1]} ${parts[2]}:${parts[3]}` : runId;
}

/**
 * `isLocked` tells a run in progress from one that died and left its status
 * on "running"; `activity` is the tool the plugin's own run is calling.
 */
export function statusText(
  lastRun: RunStatus | null,
  isLocked: boolean,
  activity = '',
): string {
  if (lastRun === null) return NEVER_RUN;
  if (lastRun.status === 'running') {
    if (!isLocked) return 'Ingest: interrupted';
    return activity ? `Ingest: running · ${activity}` : 'Ingest: running';
  }
  const cost =
    typeof lastRun.costUsd === 'number' ? `$${lastRun.costUsd.toFixed(2)}` : '';
  const parts = [lastRun.status, startedAt(lastRun.runId), cost];
  return `Ingest: ${parts.filter(Boolean).join(' · ')}`;
}

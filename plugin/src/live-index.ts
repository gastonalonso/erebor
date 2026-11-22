/** Keeps the index in step with the notes between runs. */

import { statePaths } from './plan.ts';
import { lockHolder } from './vault-files.ts';
import { rebuild } from './vault-index.ts';
import { NOTE_FOLDERS } from './vault-notes.ts';

/** Whether a vault path is one the index is built from. */
export function isInNoteFolder(path: string): boolean {
  return NOTE_FOLDERS.includes(path.split('/')[0]);
}

/** Rebuild the index, unless a run holds the lock: it rebuilds as it ends. */
export function refreshIndex(vault: string): boolean {
  if (lockHolder(statePaths(vault).lock) !== null) return false;
  rebuild(vault);
  return true;
}

// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// #42: readPersistedProviderSettings answers {} for every file it rejects, and settings:set
// builds the next file from that {} plus the single key being changed. A rejected file is
// therefore replaced by a one-key file -- every other setting gone, silently. It cannot be
// read back, so overwriting it stays the recovery path; what must not happen is the previous
// bytes vanishing. Move the file aside first.
//
// The rename/copy pair is passed in rather than imported so a test can make either one fail:
// node:test cannot mock a builtin module, and the failure branch is the whole point of this
// module. Callers pass fs.promises.

import { readPersistedProviderSettings } from '../../../packages/core/src/provider-settings.ts';

interface SettingsFileOps {
  rename: (from: string, to: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
}

// Returns the path the rejected file was preserved at, or null when there was nothing to
// preserve (no file, or a file the reader accepts). Throws when the file is rejected and
// cannot be preserved: the caller must leave it alone rather than replace it.
async function preserveRejectedSettings(
  settingsPath: string,
  { rename, copyFile }: SettingsFileOps,
): Promise<string | null> {
  // Reuse the shared reader's boundary instead of a second, weaker "does JSON.parse throw"
  // test. It rejects more than malformed syntax -- a non-object document, or providerRoots
  // that is not an object -- and everything it rejects is exactly the set of files the save
  // path would otherwise rebuild from {}. One boundary means the two can never disagree.
  if (readPersistedProviderSettings(settingsPath).ok) return null;

  // Date.now() rather than an ISO timestamp: ISO carries colons, which are not legal in a
  // Windows file name.
  const backupPath = `${settingsPath}.corrupt-${Date.now()}`;
  try {
    await rename(settingsPath, backupPath);
  } catch (renameError) {
    // A rename is refused while another handle still holds the file (a Windows indexer,
    // an open editor, antivirus). Copying preserves the same bytes without needing the
    // original to move first -- and the original is replaced by the save either way, so
    // the copy is the copy that matters. If this fails too, the caller must not save.
    try {
      await copyFile(settingsPath, backupPath);
    } catch (copyError) {
      throw new Error(
        `Obelisk could not back up ${settingsPath} before replacing it (${errorMessage(copyError)}), `
        + `so it was left unchanged and the setting was not saved.`,
        { cause: renameError },
      );
    }
  }
  return backupPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { preserveRejectedSettings };

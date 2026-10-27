// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/** A transient source observation failed; preserve its unit and retry inventory.
 * The indexers reuse their existing bounded inventory backoff, without knowing
 * provider formats. Persistent malformed transcripts are ordinary parse errors. */
export class RetryableSourceReadError extends Error {
  readonly sourcePath: string;
  constructor(sourcePath: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.sourcePath = sourcePath;
    this.name = 'RetryableSourceReadError';
  }
}

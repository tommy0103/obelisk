// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only
//
// Portions derived from `@deepseek-ai/dsh-session-persistence-jsonl`
// (https://github.com/deepseek-ai/deepseek-harness), MIT License:
//   Copyright (C) DeepSeek AI. Licensed under the MIT License.
//
// Zstandard frame primitives for DeepSeek Harness session artifacts. The
// JSONL backend writes one independently decodable, checksummed zstd frame per
// durable batch (the header line is its own first frame), so a reader can
// locate complete frames structurally and decode only those, skipping a torn
// final frame left by a crash. Obelisk only reads these artifacts, so this
// module needs no compression path.

import { zstdDecompressSync } from 'node:zlib'

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/** Structural scan result for a concatenated Zstandard stream. */
export interface ZstdFrameScan {
  /** Complete frames in file order. */
  frames: ZstdFrameRange[]
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number
}

const ZSTD_MAGIC = 0xFD2FB528

/**
 * Locate complete frames without decompressing their blocks. Invalid complete
 * structure rejects; EOF inside the final frame returns its start so callers
 * can skip the torn tail.
 * @param buffer - complete bytes currently present in the artifact.
 * @param maxFrames - optional complete-frame limit for metadata-only readers.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/**
 * Decode a DeepSeek Harness session artifact (concatenated checksummed zstd
 * frames) into its plaintext JSONL. Complete frames are decoded in order;
 * a structurally incomplete final frame (crash tail) is skipped. The first
 * frame must be present and hold the header line.
 * @param buffer - complete artifact bytes.
 * @returns the decoded JSONL text plus whether a torn tail was skipped.
 */
export function decodeZstdArtifact(buffer: Buffer): { text: string; torn: boolean } {
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const plaintexts: Buffer[] = []
  for (const { start, end } of frames) {
    let decoded: Buffer
    try {
      decoded = zstdDecompressSync(buffer.subarray(start, end))
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, {
        cause: error,
      })
    }
    plaintexts.push(decoded)
  }
  return { text: Buffer.concat(plaintexts).toString('utf8'), torn: tornStart !== undefined }
}

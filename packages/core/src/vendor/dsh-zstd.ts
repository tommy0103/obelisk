// Vendored from DeepSeek Harness — github.com/deepseek-ai/deepseek-harness.
//
// Upstream source files (MIT License, Copyright (c) DeepSeek AI):
//   packages/session/session-persistence-jsonl/src/zstd.ts
//   packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts
//   packages/session/session-persistence-jsonl/src/zstd-private-decoder.ts
// Vendored at commit 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
// (last touch 25dcd7293c "docs: purge chain-of-thought leakage from prose").
//
// Adapted for Obelisk: this is a read-only port. The upstream write-side
// helpers (compressZstdFrame, decompressZstdPrefix) and the `@deepseek-ai/*`
// type imports are omitted; the local types are re-declared so the module is
// self-contained. Logic follows upstream verbatim. See vendor/README.md for
// the sync procedure.
//
// DeepSeek Harness stores a session log as a concatenation of independent
// Zstandard frames (one checksummed frame per append batch). Node's one-shot
// `zstdDecompressSync` stops at the first frame boundary, so callers must scan
// the structural frame ranges first, then decode each complete frame.

import { constants as bufferConstants } from 'node:buffer';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number;
  /** Exclusive frame end. */
  end: number;
}

/** Structural scan result for a concatenated Zstandard stream. */
export interface ZstdFrameScan {
  /** Complete frames in file order. */
  frames: ZstdFrameRange[];
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number;
}

/**
 * Locate complete frames without decompressing their blocks. Invalid complete
 * structure rejects; EOF inside the final frame returns its start for repair.
 * @param buffer - complete bytes currently present in the session artifact.
 * @param maxFrames - optional complete-frame limit for metadata-only readers.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/** Common lifecycle for interchangeable synchronous multi-frame decoders. */
export interface ZstdFrameDecoder {
  /**
   * Decode and checksum complete frames in source order. Each yielded buffer
   * remains valid only until the iterator advances to the next frame.
   * @param source - concatenated Zstandard frame bytes.
   * @param frames - structurally complete ranges within `source`.
   * @returns one plaintext buffer per frame.
   */
  decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void>;
  /** Release decoder-owned resources; repeated calls are harmless. */
  close(): void;
}

/** Multi-frame adapter built exclusively from Node's supported one-shot API. */
class PublicZstdFrameDecoder implements ZstdFrameDecoder {
  private started = false;
  private closed = false;

  /** @inheritdoc */
  public *decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void> {
    if (this.started) throw new Error('Zstandard frame decoder was already started');
    if (this.closed) throw new Error('cannot start a closed Zstandard frame decoder');
    this.started = true;
    try {
      for (const { start, end } of frames) {
        let decoded: Buffer;
        try {
          decoded = zstdDecompressSync(source.subarray(start, end));
        } catch (error) {
          throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, {
            cause: error,
          });
        }
        yield decoded;
      }
    } finally {
      this.close();
    }
  }

  /** @inheritdoc */
  close(): void {
    this.closed = true;
  }
}

const DECODE_CHUNK_SIZE = 1024 * 1024;

interface NodeZstdPrivateHandle {
  writeSync(
    flushFlag: number,
    input: Buffer,
    inputOffset: number,
    inputLength: number,
    output: Buffer,
    outputOffset: number,
    outputLength: number,
  ): void;
}

type NodeZstdPrivateWriteState = Uint32Array & { 0: number; 1: number };

interface NodeZstdPrivateState {
  [key: symbol]: unknown;
  _handle: NodeZstdPrivateHandle | null;
  _writeState: NodeZstdPrivateWriteState;
  _defaultFlushFlag: number;
}

type NodeZstdPrivateStream = ReturnType<typeof createZstdDecompress> & NodeZstdPrivateState;

/** Return the stream with its observed private Node contract, or reject that optimization. */
function privateZstdStream(
  stream: ReturnType<typeof createZstdDecompress>,
): { stream: NodeZstdPrivateStream; errorKey: symbol } | undefined {
  const candidate = stream as unknown as Partial<NodeZstdPrivateState>;
  const handle = candidate._handle;
  const errorKey = Reflect.ownKeys(stream).find((key): key is symbol => (
    typeof key === 'symbol' && key.description === 'kError'
  ));
  /* v8 ignore next -- one test runtime exposes one Node-private shape; the Node 22/24/26 matrix checks compatibility. */
  if (
    typeof handle !== 'object' || handle === null
    || typeof (handle as { writeSync?: unknown }).writeSync !== 'function'
    || !(candidate._writeState instanceof Uint32Array)
    || candidate._writeState.length < 2
    || typeof candidate._defaultFlushFlag !== 'number'
    || errorKey === undefined
    || candidate[errorKey] !== null
  ) return undefined;
  return { stream: stream as NodeZstdPrivateStream, errorKey };
}

/**
 * Synchronous multi-frame decoder backed by one Node Zstd stream handle. Node
 * exposes synchronous decoding only as a one-shot API, so this adapter uses
 * the stream's private handle contract to reuse its native context and output
 * chunks across frames.
 */
class NodePrivateZstdFrameDecoder implements ZstdFrameDecoder {
  private readonly output = Buffer.allocUnsafe(DECODE_CHUNK_SIZE);
  private readonly stream: NodeZstdPrivateStream;
  private readonly errorKey: symbol;
  private decoderError?: Error;
  private started = false;
  private closed = false;

  private constructor(stream: NodeZstdPrivateStream, errorKey: symbol) {
    this.stream = stream;
    this.errorKey = errorKey;
    this.stream.on('error', (error: Error) => {
      this.decoderError ??= error;
    });
  }

  /**
   * Create the optimized decoder when this Node release exposes the expected
   * private stream shape.
   * @returns a shared decoder, or `undefined` when callers must use the public fallback.
   */
  static create(): NodePrivateZstdFrameDecoder | undefined {
    const stream = createZstdDecompress({ chunkSize: DECODE_CHUNK_SIZE });
    const privateAccess = privateZstdStream(stream);
    /* v8 ignore next -- reached only when a supported Node release changes its private stream shape. */
    if (privateAccess !== undefined) {
      return new NodePrivateZstdFrameDecoder(privateAccess.stream, privateAccess.errorKey);
    }
    /* v8 ignore next -- the active Node runtime passed the private-shape probe above. */
    stream.close();
    /* v8 ignore next -- the active Node runtime passed the private-shape probe above. */
    return undefined;
  }

  /** @inheritdoc */
  public *decode(source: Buffer, frames: readonly ZstdFrameRange[]): Generator<Buffer, void, void> {
    if (this.started) throw new Error('Zstandard frame decoder was already started');
    if (this.closed) throw new Error('cannot start a closed Zstandard frame decoder');
    this.started = true;
    try {
      for (const frame of frames) {
        try {
          yield this.decodeFrame(source.subarray(frame.start, frame.end));
        } catch (error) {
          throw new Error(`corrupt Zstandard session log: frame at byte ${frame.start} failed validation`, {
            cause: error,
          });
        }
      }
    } finally {
      this.close();
    }
  }

  /** Decode one frame; its returned scratch view remains valid until the next call. */
  private decodeFrame(input: Buffer): Buffer {
    const handle = this.stream._handle;
    /* v8 ignore next -- decode() rejects closed instances before entering this private frame operation. */
    if (this.closed || handle === null) throw new Error('cannot decode with a closed Zstandard frame decoder');

    let inputOffset = 0;
    let inputRemaining = input.length;
    let outputBytes = 0;
    const fullChunks: Buffer[] = [];
    for (;;) {
      handle.writeSync(
        this.stream._defaultFlushFlag,
        input,
        inputOffset,
        inputRemaining,
        this.output,
        0,
        this.output.length,
      );
      if (this.decoderError !== undefined) throw this.decoderError;
      const internalError = this.stream[this.errorKey];
      if (internalError !== null) {
        if (internalError instanceof Error) throw internalError;
        throw new Error('Zstandard decoder exposed a non-Error internal failure');
      }

      const outputAfter = this.stream._writeState[0];
      const inputAfter = this.stream._writeState[1];
      const consumed = inputRemaining - inputAfter;
      const produced = this.output.length - outputAfter;
      if (produced > 0) {
        outputBytes += produced;
        /* v8 ignore next -- Buffer cannot materialize a frame beyond its own process-wide maximum length. */
        if (outputBytes > bufferConstants.MAX_LENGTH) {
          throw new Error(`Zstandard frame output exceeds ${bufferConstants.MAX_LENGTH} bytes`);
        }
      }

      if (outputAfter !== 0) {
        /* v8 ignore next -- structurally scanned ranges contain exactly one complete frame and no trailing bytes. */
        if (inputAfter !== 0) throw new Error('Zstandard frame decoder left trailing input');
        const finalChunk = this.output.subarray(0, produced);
        if (fullChunks.length === 0) return finalChunk;
        if (produced > 0) fullChunks.push(Buffer.from(finalChunk));
        const onlyChunk = fullChunks[0] as Buffer;
        return fullChunks.length === 1
          ? onlyChunk
          : Buffer.concat(fullChunks, outputBytes);
      }
      fullChunks.push(Buffer.from(this.output));
      inputOffset += consumed;
      inputRemaining = inputAfter;
    }
  }

  /** @inheritdoc */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.close();
  }
}

/**
 * Select the shared private decoder when the running Node shape is compatible,
 * otherwise preserve correctness with the public one-shot API.
 * @returns a synchronous decoder with an implementation-independent lifecycle.
 */
export function createZstdFrameDecoder(): ZstdFrameDecoder {
  return NodePrivateZstdFrameDecoder.create() ?? new PublicZstdFrameDecoder();
}

/**
 * JSONL session log parser for DSH session artifacts.
 *
 * Handles the two physical encodings the DSH JSONL persistence backend writes:
 *   - plain `.jsonl` (compression: 'none')
 *   - `.jsonl.zstd` — a concatenation of independently-checksummed Zstandard
 *     frames (one header frame, then one frame per durable append batch).
 *
 * Packed chunk rows (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`,
 * written when `packChunks` is enabled) expand to `assistant/chunk` events that
 * no current metric consumes, so they are skipped. Every other line is a
 * `SessionEvent` envelope (`type` / `seq` / `time` / `data`).
 */

import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  seedLength?: number
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

export interface ParsedSession {
  header: SessionHeader
  events: SessionEvent[]
}

/** Zstandard frame magic `0xFD2FB528`, little-endian (bytes 28 B5 2F FD). */
const ZSTD_MAGIC = 4247762216

/** Byte range occupied by one structurally complete Zstandard frame. */
interface ZstdFrameRange {
  start: number
  end: number
}

/**
 * Locate complete Zstandard frames in a concatenated-frame container without
 * decompressing their blocks. Mirrors `dsh-session-persistence-jsonl`'s frame
 * layout: 4-byte magic, 1-byte descriptor, optional header bytes, blocks,
 * optional 4-byte checksum.
 */
function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Decompress a `.jsonl.zstd` container into its plaintext JSONL body. */
function decodeZstd(buffer: Buffer): string {
  const frames = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('corrupt Zstandard session log: no complete frames')
  return Buffer.concat(
    frames.map((f) => zstdDecompressSync(buffer.subarray(f.start, f.end))),
  ).toString('utf8')
}

/** Read and decode a session log file (plain `.jsonl` or compressed `.jsonl.zstd`). */
export async function parseSessionFile(path: string): Promise<ParsedSession> {
  const buffer = await readFile(path)
  const isZstd = buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC
  const content = isZstd ? decodeZstd(buffer) : buffer.toString('utf8')
  return parseSessionContent(content)
}

/** Parse already-decoded JSONL text into a header plus an ordered event list. */
export function parseSessionContent(content: string): ParsedSession {
  const lines = content.trim().split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) throw new Error('Empty session file')

  const firstLine = JSON.parse(lines[0]) as SessionHeader
  if (firstLine.type !== 'session') {
    throw new Error(`Expected session header, got type: ${String(firstLine.type)}`)
  }

  const events: SessionEvent[] = []
  for (let i = 1; i < lines.length; i++) {
    const parsed: unknown = JSON.parse(lines[i])
    if (isEventRecord(parsed)) events.push(parsed as SessionEvent)
  }
  return { header: firstLine, events }
}

function isEventRecord(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.type === 'string' &&
    typeof record.seq === 'number' &&
    typeof record.time === 'number' &&
    typeof record.data === 'object' &&
    record.data !== null
  )
}

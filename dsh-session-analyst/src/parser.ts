/**
 * JSONL session log parser. Reads dsh session files into structured events.
 */

import { readFile } from 'node:fs/promises'

export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  origin?: 'subagent'
  delegationDepth?: number
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

export interface ParsedSession {
  header: SessionHeader
  events: SessionEvent[]
}

export async function parseSessionFile(path: string): Promise<ParsedSession> {
  const content = await readFile(path, 'utf-8')
  return parseSessionContent(content)
}

export function parseSessionContent(content: string): ParsedSession {
  const lines = content.trim().split('\n').filter(l => l.length > 0)
  if (lines.length === 0) throw new Error('Empty session file')

  const firstLine = JSON.parse(lines[0])
  if (firstLine.type !== 'session') {
    throw new Error(`Expected session header, got type: ${firstLine.type}`)
  }

  const header: SessionHeader = firstLine
  const events: SessionEvent[] = []

  for (let i = 1; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i])
    if (parsed.type && parsed.seq !== undefined) {
      events.push(parsed as SessionEvent)
    }
  }

  return { header, events }
}

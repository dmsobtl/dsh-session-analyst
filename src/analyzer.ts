/**
 * Core analysis engine. Computes quality metrics from parsed session events.
 *
 * Metrics are derived from the REAL DSH session event shapes:
 *   - `tool/result` carries the call id at `data.message.source.callId` and the
 *     error flag on its `tool-result` content block (`data.message.content[].isError`),
 *     or as an internal failure at `data.error`.
 *   - `assistant/message` carries `data.usage` (`inputTokens` / `outputTokens` /
 *     `reasoningTokens` / `cacheReadTokens`).
 */

import type { ParsedSession, SessionEvent } from './parser.js'

export interface AnalyzeOptions {
  /** Calls with identical name+arguments beyond this many times are flagged redundant. */
  redundantCallThreshold?: number
  /** A turn with more steps than this is flagged as a possible loop. */
  excessiveStepThreshold?: number
}

export interface TurnMetrics {
  turn: number
  stepCount: number
  toolCalls: ToolCallRecord[]
  tokenUsage: TokenUsage
  durationMs: number
  endReason: string
  issues: Issue[]
}

export interface ToolCallRecord {
  callId: string
  name: string
  arguments: string
  isError: boolean
  durationMs: number
}

export interface Issue {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  turn: number
  step?: number
  callId?: string
}

export interface SessionAnalysis {
  sessionId: string
  createdAt: number
  cwd?: string
  summary: SessionSummary
  turns: TurnMetrics[]
  issues: Issue[]
  toolStats: ToolStats
  tokenStats: TokenStats
}

export interface SessionSummary {
  totalTurns: number
  totalSteps: number
  totalToolCalls: number
  totalErrors: number
  totalDurationMs: number
  successRate: number
  avgStepsPerTurn: number
  avgToolCallsPerTurn: number
}

export interface ToolStats {
  byName: Record<string, { count: number; errors: number; avgDurationMs: number }>
  redundantCalls: RedundantCall[]
  errorRate: number
}

export interface RedundantCall {
  name: string
  arguments: string
  occurrences: number
  turns: number[]
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

export interface TokenStats {
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  outputPerTurn: number[]
  efficiency: number
}

export function analyzeSession(session: ParsedSession, options: AnalyzeOptions = {}): SessionAnalysis {
  const redundantThreshold = options.redundantCallThreshold ?? 3
  const excessiveStepThreshold = options.excessiveStepThreshold ?? 10

  const turns = extractTurns(session.events)
  const allToolCalls = turns.flatMap((t) => t.toolCalls)
  const allIssues = turns.flatMap((t) => t.issues)

  const toolStats = computeToolStats(allToolCalls, turns)
  const tokenStats = computeTokenStats(turns)

  allIssues.push(...detectRedundantCalls(turns, redundantThreshold))
  allIssues.push(...detectHighErrorRate(toolStats))
  allIssues.push(...detectExcessiveSteps(turns, excessiveStepThreshold))

  const totalErrors = allToolCalls.filter((tc) => tc.isError).length

  return {
    sessionId: session.header.id,
    createdAt: session.header.createdAt,
    ...(session.header.cwd !== undefined ? { cwd: session.header.cwd } : {}),
    summary: {
      totalTurns: turns.length,
      totalSteps: turns.reduce((s, t) => s + t.stepCount, 0),
      totalToolCalls: allToolCalls.length,
      totalErrors,
      totalDurationMs: turns.reduce((s, t) => s + t.durationMs, 0),
      successRate: allToolCalls.length > 0
        ? (allToolCalls.length - totalErrors) / allToolCalls.length
        : 1,
      avgStepsPerTurn: turns.length > 0
        ? turns.reduce((s, t) => s + t.stepCount, 0) / turns.length
        : 0,
      avgToolCallsPerTurn: turns.length > 0
        ? allToolCalls.length / turns.length
        : 0,
    },
    turns,
    issues: allIssues,
    toolStats,
    tokenStats,
  }
}

interface ToolResultContentBlock {
  type?: string
  toolCallId?: string
  isError?: boolean
}

/** Extract the paired call id from a real `tool/result` event. */
function resolveToolResultCallId(data: Record<string, unknown>): string | undefined {
  const message = data.message as { source?: { callId?: unknown }; content?: unknown } | undefined
  const sourceCallId = message?.source?.callId
  if (typeof sourceCallId === 'string' && sourceCallId.length > 0) return sourceCallId
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block && typeof block === 'object') {
        const b = block as ToolResultContentBlock
        if (typeof b.toolCallId === 'string' && b.toolCallId.length > 0) return b.toolCallId
      }
    }
  }
  return undefined
}

/** Whether a real `tool/result` event represents a failed call. */
function resolveToolResultIsError(data: Record<string, unknown>): boolean {
  if (data.error !== undefined && data.error !== null) return true
  const message = data.message as { content?: unknown } | undefined
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block && typeof block === 'object') {
        const b = block as ToolResultContentBlock
        if (b.type === 'tool-result' && b.isError === true) return true
      }
    }
  }
  return false
}

function extractTurns(events: SessionEvent[]): TurnMetrics[] {
  const turns: TurnMetrics[] = []
  let current: (TurnMetrics & { startTime?: number }) | null = null
  const callMeta = new Map<string, { name: string; arguments: string; time: number }>()
  let lastTime = 0

  const flushTurn = () => {
    if (!current) return
    const endTime = lastTime || current.startTime || 0
    const { startTime, ...metrics } = current
    metrics.durationMs = endTime - (startTime ?? endTime)
    turns.push(metrics)
    current = null
  }

  for (const event of events) {
    lastTime = event.time
    switch (event.type) {
      case 'turn/start': {
        flushTurn()
        current = {
          turn: (event.data as { turn: number }).turn,
          stepCount: 0,
          toolCalls: [],
          tokenUsage: {},
          durationMs: 0,
          endReason: 'in-progress',
          issues: [],
          startTime: event.time,
        }
        break
      }
      case 'step/start': {
        if (current) current.stepCount++
        break
      }
      case 'tool/call': {
        const data = event.data as { callId: string; name: string; arguments: string }
        callMeta.set(data.callId, { name: data.name, arguments: data.arguments, time: event.time })
        break
      }
      case 'tool/result': {
        if (!current) break
        const callId = resolveToolResultCallId(event.data)
        const meta = callId !== undefined ? callMeta.get(callId) : undefined
        const isError = resolveToolResultIsError(event.data)
        const record: ToolCallRecord = {
          callId: callId ?? '',
          name: meta?.name ?? 'unknown',
          arguments: meta?.arguments ?? '',
          isError,
          durationMs: meta ? event.time - meta.time : 0,
        }
        current.toolCalls.push(record)
        if (isError) {
          current.issues.push({
            severity: 'warning',
            code: 'TOOL_ERROR',
            message: `Tool "${record.name}" returned error`,
            turn: current.turn,
            ...(callId !== undefined ? { callId } : {}),
          })
        }
        break
      }
      case 'assistant/message': {
        const data = event.data as { usage?: TokenUsage }
        if (current && data.usage) {
          const u = current.tokenUsage
          u.inputTokens = (u.inputTokens ?? 0) + (data.usage.inputTokens ?? 0)
          u.outputTokens = (u.outputTokens ?? 0) + (data.usage.outputTokens ?? 0)
          u.reasoningTokens = (u.reasoningTokens ?? 0) + (data.usage.reasoningTokens ?? 0)
          u.cacheReadTokens = (u.cacheReadTokens ?? 0) + (data.usage.cacheReadTokens ?? 0)
        }
        break
      }
      case 'turn/end': {
        if (current) {
          const data = event.data as { reason?: { kind?: string } }
          current.endReason = data.reason?.kind ?? 'unknown'
          flushTurn()
        }
        break
      }
    }
  }
  flushTurn()
  return turns
}

function computeToolStats(calls: ToolCallRecord[], turns: TurnMetrics[]): ToolStats {
  const byName: ToolStats['byName'] = {}
  for (const call of calls) {
    const entry = byName[call.name] ?? { count: 0, errors: 0, avgDurationMs: 0 }
    entry.count++
    if (call.isError) entry.errors++
    entry.avgDurationMs += call.durationMs
    byName[call.name] = entry
  }
  for (const stat of Object.values(byName)) {
    if (stat.count > 0) stat.avgDurationMs /= stat.count
  }

  const redundantCalls = detectRedundantCallRecords(turns)
  const errorRate = calls.length > 0
    ? calls.filter((c) => c.isError).length / calls.length
    : 0

  return { byName, redundantCalls, errorRate }
}

function computeTokenStats(turns: TurnMetrics[]): TokenStats {
  let totalInput = 0
  let totalOutput = 0
  let totalReasoning = 0
  let totalCacheRead = 0
  const outputPerTurn: number[] = []

  for (const turn of turns) {
    const u = turn.tokenUsage
    totalInput += u.inputTokens ?? 0
    totalOutput += u.outputTokens ?? 0
    totalReasoning += u.reasoningTokens ?? 0
    totalCacheRead += u.cacheReadTokens ?? 0
    outputPerTurn.push(u.outputTokens ?? 0)
  }

  const totalConsumed = totalInput + totalOutput + totalReasoning
  const efficiency = totalConsumed > 0 ? totalOutput / totalConsumed : 0

  return { totalInput, totalOutput, totalReasoning, totalCacheRead, outputPerTurn, efficiency }
}

function detectRedundantCallRecords(turns: TurnMetrics[]): RedundantCall[] {
  const seen = new Map<string, { name: string; arguments: string; count: number; turns: number[] }>()

  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const key = `${call.name}\u0000${call.arguments}`
      const entry = seen.get(key) ?? { name: call.name, arguments: call.arguments, count: 0, turns: [] }
      entry.count++
      if (!entry.turns.includes(turn.turn)) entry.turns.push(turn.turn)
      seen.set(key, entry)
    }
  }

  return [...seen.values()]
    .filter((e) => e.count > 1)
    .map((e) => ({ name: e.name, arguments: e.arguments, occurrences: e.count, turns: e.turns }))
    .sort((a, b) => b.occurrences - a.occurrences)
}

function detectRedundantCalls(turns: TurnMetrics[], threshold: number): Issue[] {
  return detectRedundantCallRecords(turns)
    .filter((r) => r.occurrences >= threshold)
    .map((r) => ({
      severity: 'warning' as const,
      code: 'REDUNDANT_TOOL_CALL',
      message: `Tool "${r.name}" called ${r.occurrences} times with identical arguments`,
      turn: r.turns[0],
    }))
}

function detectHighErrorRate(stats: ToolStats): Issue[] {
  const issues: Issue[] = []
  for (const [name, stat] of Object.entries(stats.byName)) {
    if (stat.count >= 3 && stat.errors / stat.count > 0.5) {
      issues.push({
        severity: 'error',
        code: 'HIGH_TOOL_ERROR_RATE',
        message: `Tool "${name}" has ${Math.round((stat.errors / stat.count) * 100)}% error rate (${stat.errors}/${stat.count})`,
        turn: 0,
      })
    }
  }
  return issues
}

function detectExcessiveSteps(turns: TurnMetrics[], threshold: number): Issue[] {
  return turns
    .filter((t) => t.stepCount > threshold)
    .map((t) => ({
      severity: 'info' as const,
      code: 'EXCESSIVE_STEPS',
      message: `Turn ${t.turn} took ${t.stepCount} steps — may indicate the model is stuck in a loop`,
      turn: t.turn,
    }))
}

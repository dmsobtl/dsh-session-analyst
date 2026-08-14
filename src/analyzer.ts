/**
 * Core analysis engine. Computes quality metrics from parsed session events.
 */

import type { ParsedSession, SessionEvent, TokenUsage } from './parser.ts'

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

export interface TokenStats {
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  outputPerTurn: number[]
  efficiency: number
}

export function analyzeSession(session: ParsedSession): SessionAnalysis {
  const turns = extractTurns(session.events)
  const allToolCalls = turns.flatMap(t => t.toolCalls)
  const allIssues = turns.flatMap(t => t.issues)

  const toolStats = computeToolStats(allToolCalls, turns)
  const tokenStats = computeTokenStats(turns)

  allIssues.push(...detectRedundantCalls(turns))
  allIssues.push(...detectHighErrorRate(toolStats))
  allIssues.push(...detectExcessiveSteps(turns))

  const totalErrors = allToolCalls.filter(tc => tc.isError).length

  return {
    sessionId: session.header.id,
    createdAt: session.header.createdAt,
    cwd: session.header.cwd,
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

function extractTurns(events: SessionEvent[]): TurnMetrics[] {
  const turns: TurnMetrics[] = []
  let currentTurn: Partial<TurnMetrics> & { startTime?: number } = {}
  let toolCallTimes = new Map<string, number>()

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        const turnNum = (event.data as { turn: number }).turn
        currentTurn = {
          turn: turnNum,
          stepCount: 0,
          toolCalls: [],
          tokenUsage: {},
          durationMs: 0,
          endReason: 'unknown',
          issues: [],
          startTime: event.time,
        }
        toolCallTimes = new Map()
        break
      }
      case 'step/start': {
        if (currentTurn.stepCount !== undefined) currentTurn.stepCount++
        break
      }
      case 'tool/call': {
        const data = event.data as { callId: string; name: string; arguments: string }
        toolCallTimes.set(data.callId, event.time)
        break
      }
      case 'tool/result': {
        const data = event.data as { callId: string; content: unknown[]; isError: boolean }
        const startTime = toolCallTimes.get(data.callId) ?? event.time
        const callEvent = events.find(
          e => e.type === 'tool/call' && (e.data as { callId: string }).callId === data.callId
        )
        const record: ToolCallRecord = {
          callId: data.callId,
          name: callEvent ? (callEvent.data as { name: string }).name : 'unknown',
          arguments: callEvent ? (callEvent.data as { arguments: string }).arguments : '',
          isError: data.isError,
          durationMs: event.time - startTime,
        }
        currentTurn.toolCalls?.push(record)

        if (data.isError) {
          currentTurn.issues?.push({
            severity: 'warning',
            code: 'TOOL_ERROR',
            message: `Tool "${record.name}" returned error`,
            turn: currentTurn.turn ?? 0,
            callId: data.callId,
          })
        }
        break
      }
      case 'assistant/message': {
        const data = event.data as { usage?: TokenUsage }
        if (data.usage) {
          const usage = currentTurn.tokenUsage ?? {}
          usage.inputTokens = (usage.inputTokens ?? 0) + (data.usage.inputTokens ?? 0)
          usage.outputTokens = (usage.outputTokens ?? 0) + (data.usage.outputTokens ?? 0)
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (data.usage.reasoningTokens ?? 0)
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (data.usage.cacheReadTokens ?? 0)
          currentTurn.tokenUsage = usage
        }
        break
      }
      case 'turn/end': {
        const data = event.data as { reason: { kind: string } }
        currentTurn.endReason = data.reason.kind
        currentTurn.durationMs = event.time - (currentTurn.startTime ?? event.time)
        const { startTime: _, ...metrics } = currentTurn
        turns.push(metrics as TurnMetrics)
        break
      }
    }
  }

  return turns
}

function computeToolStats(calls: ToolCallRecord[], turns: TurnMetrics[]): ToolStats {
  const byName: ToolStats['byName'] = {}
  for (const call of calls) {
    if (!byName[call.name]) {
      byName[call.name] = { count: 0, errors: 0, avgDurationMs: 0 }
    }
    byName[call.name].count++
    if (call.isError) byName[call.name].errors++
    byName[call.name].avgDurationMs += call.durationMs
  }
  for (const stat of Object.values(byName)) {
    if (stat.count > 0) stat.avgDurationMs /= stat.count
  }

  const redundantCalls = detectRedundantCallRecords(turns)
  const errorRate = calls.length > 0
    ? calls.filter(c => c.isError).length / calls.length
    : 0

  return { byName, redundantCalls, errorRate }
}

function computeTokenStats(turns: TurnMetrics[]): TokenStats {
  let totalInput = 0, totalOutput = 0, totalReasoning = 0, totalCacheRead = 0
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
  const seen = new Map<string, { count: number; turns: number[] }>()

  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const key = `${call.name}::${call.arguments}`
      const entry = seen.get(key) ?? { count: 0, turns: [] }
      entry.count++
      if (!entry.turns.includes(turn.turn)) entry.turns.push(turn.turn)
      seen.set(key, entry)
    }
  }

  const redundant: RedundantCall[] = []
  for (const [key, entry] of seen) {
    if (entry.count > 1) {
      const [name, args] = key.split('::')
      redundant.push({ name, arguments: args, occurrences: entry.count, turns: entry.turns })
    }
  }

  return redundant.sort((a, b) => b.occurrences - a.occurrences)
}

function detectRedundantCalls(turns: TurnMetrics[]): Issue[] {
  const redundant = detectRedundantCallRecords(turns)
  return redundant
    .filter(r => r.occurrences >= 3)
    .map(r => ({
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
        message: `Tool "${name}" has ${Math.round(stat.errors / stat.count * 100)}% error rate (${stat.errors}/${stat.count})`,
        turn: 0,
      })
    }
  }
  return issues
}

function detectExcessiveSteps(turns: TurnMetrics[]): Issue[] {
  return turns
    .filter(t => t.stepCount > 10)
    .map(t => ({
      severity: 'info' as const,
      code: 'EXCESSIVE_STEPS',
      message: `Turn ${t.turn} took ${t.stepCount} steps — may indicate the model is stuck in a loop`,
      turn: t.turn,
    }))
}

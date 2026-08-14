/**
 * dsh-session-analyst: Session quality analysis plugin for DeepSeek Harness.
 *
 * Registers two model-facing tools:
 * - `analyze_session`: Parse and analyze a session log file (`.jsonl` or `.jsonl.zstd`)
 * - `compare_sessions`: Compare two sessions to detect regressions
 *
 * The parser/analyzer/comparator are also exported as a standalone library.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseSessionFile } from './parser.ts'
import { analyzeSession, type SessionAnalysis } from './analyzer.ts'
import { compareSessions, type ComparisonResult } from './comparator.ts'

export { parseSessionFile, parseSessionContent } from './parser.ts'
export { analyzeSession } from './analyzer.ts'
export { compareSessions } from './comparator.ts'
export type { SessionAnalysis, TurnMetrics, Issue, ToolStats, TokenStats, AnalyzeOptions } from './analyzer.ts'
export type { ComparisonResult, Regression } from './comparator.ts'

export const name = 'session-analyst'
export const inject = ['tools']

export const Config = z.object({
  redundantCallThreshold: z.number().default(3),
  excessiveStepThreshold: z.number().default(10),
})

interface ResolvedConfig {
  redundantCallThreshold: number
  excessiveStepThreshold: number
}

export function apply(ctx: Context, config: ResolvedConfig) {
  const { redundantCallThreshold, excessiveStepThreshold } = config

  ctx.tools.register(defineTool({
    name: 'analyze_session',
    description: 'Analyze a DSH session log file (.jsonl or .jsonl.zstd) and return structured quality metrics: tool success rate, token efficiency, redundant calls, error patterns, and a turn-by-turn breakdown.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the session .jsonl or .jsonl.zstd file',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderAnalysis(value) }],
    },
    async execute(args) {
      const session = await parseSessionFile(args.path)
      const analysis = analyzeSession(session, { redundantCallThreshold, excessiveStepThreshold })
      return JSON.parse(JSON.stringify(analysis))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'compare_sessions',
    description: 'Compare two DSH session log files (baseline vs current) and report regressions, improvements, and deltas across quality dimensions.',
    parameters: {
      baseline: {
        type: 'string',
        required: true,
        description: 'Path to the baseline session .jsonl or .jsonl.zstd file',
      },
      current: {
        type: 'string',
        required: true,
        description: 'Path to the current session .jsonl or .jsonl.zstd file',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const baselineSession = await parseSessionFile(args.baseline)
      const currentSession = await parseSessionFile(args.current)
      const baselineAnalysis = analyzeSession(baselineSession, { redundantCallThreshold, excessiveStepThreshold })
      const currentAnalysis = analyzeSession(currentSession, { redundantCallThreshold, excessiveStepThreshold })
      const comparison = compareSessions(baselineAnalysis, currentAnalysis)
      return JSON.parse(JSON.stringify(comparison))
    },
  }))
}

/** Compact, human-readable rendering of an analysis for the model. */
function renderAnalysis(value: unknown): string {
  const a = value as SessionAnalysis
  const { summary, tokenStats, toolStats, issues } = a

  const toolLines = Object.entries(toolStats.byName).map(
    ([toolName, stat]) => `  ${toolName}: ${stat.count} calls, ${stat.errors} errors, avg ${Math.round(stat.avgDurationMs)}ms`,
  )

  const parts: string[] = [
    `Session ${a.sessionId}`,
    `  turns=${summary.totalTurns} steps=${summary.totalSteps} toolCalls=${summary.totalToolCalls}`,
    `  errors=${summary.totalErrors} successRate=${(summary.successRate * 100).toFixed(1)}% duration=${(summary.totalDurationMs / 1000).toFixed(1)}s`,
    `  avgStepsPerTurn=${summary.avgStepsPerTurn.toFixed(2)} avgToolCallsPerTurn=${summary.avgToolCallsPerTurn.toFixed(2)}`,
    '',
    `Token stats: input=${tokenStats.totalInput} output=${tokenStats.totalOutput} reasoning=${tokenStats.totalReasoning} cacheRead=${tokenStats.totalCacheRead} efficiency=${(tokenStats.efficiency * 100).toFixed(1)}%`,
    '',
    'Tool stats:',
    ...(toolLines.length > 0 ? toolLines : ['  (none)']),
  ]

  if (toolStats.redundantCalls.length > 0) {
    parts.push('', 'Redundant calls:')
    parts.push(...toolStats.redundantCalls.slice(0, 10).map((r) => `  ${r.name} x${r.occurrences}${r.arguments ? ` ${r.arguments.slice(0, 80)}` : ''}`))
  }

  if (issues.length > 0) {
    parts.push('', `Issues (${issues.length}):`)
    parts.push(...issues.map((i) => `  [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`))
  } else {
    parts.push('', 'No issues detected.')
  }

  return parts.join('\n')
}

/**
 * dsh-session-analyst: Session quality analysis plugin for DeepSeek Harness.
 *
 * Registers two model-facing tools:
 * - `analyze_session`: Parse and analyze a session JSONL file
 * - `compare_sessions`: Compare two sessions to detect regressions
 *
 * Also provides a `session/event` listener for live quality monitoring.
 */

import type { Context } from '@deepseek-ai/cordis'
import { parseSessionFile } from './parser.ts'
import { analyzeSession } from './analyzer.ts'
import { compareSessions } from './comparator.ts'

export { parseSessionFile, parseSessionContent } from './parser.ts'
export { analyzeSession } from './analyzer.ts'
export { compareSessions } from './comparator.ts'
export type { SessionAnalysis, TurnMetrics, Issue, ToolStats, TokenStats } from './analyzer.ts'
export type { ComparisonResult, Regression } from './comparator.ts'

export const name = 'session-analyst'
export const inject = ['tools']

export interface Config {
  liveMonitoring?: boolean
  redundantCallThreshold?: number
  excessiveStepThreshold?: number
}

export function apply(ctx: Context, config: Config) {
  const redundantThreshold = config.redundantCallThreshold ?? 3
  const excessiveSteps = config.excessiveStepThreshold ?? 10

  ctx.tools.register({
    name: 'analyze_session',
    description: 'Analyze a DSH session JSONL file and return structured quality metrics: tool success rate, token efficiency, redundant calls, error patterns, and turn-by-turn breakdown.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the session .jsonl file',
        },
      },
      required: ['path'],
    },
    async execute(args: { path: string }) {
      const session = await parseSessionFile(args.path)
      const analysis = analyzeSession(session)

      const issuesSummary = analysis.issues.length > 0
        ? `\n\nIssues found (${analysis.issues.length}):\n` +
          analysis.issues.map(i => `  [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`).join('\n')
        : '\n\nNo issues detected.'

      const toolSummary = Object.entries(analysis.toolStats.byName)
        .map(([name, stat]) => `  ${name}: ${stat.count} calls, ${stat.errors} errors, avg ${Math.round(stat.avgDurationMs)}ms`)
        .join('\n')

      return [{ type: 'text', text: JSON.stringify({
        summary: analysis.summary,
        tokenStats: analysis.tokenStats,
        toolStats: { byName: analysis.toolStats.byName, errorRate: analysis.toolStats.errorRate },
        redundantCalls: analysis.toolStats.redundantCalls.slice(0, 10),
        issues: analysis.issues,
        turns: analysis.turns.map(t => ({
          turn: t.turn,
          steps: t.stepCount,
          toolCalls: t.toolCalls.length,
          errors: t.toolCalls.filter(tc => tc.isError).length,
          endReason: t.endReason,
          durationMs: t.durationMs,
        })),
      }, null, 2)}]
    },
  })

  ctx.tools.register({
    name: 'compare_sessions',
    description: 'Compare two session JSONL files (baseline vs current) and report regressions, improvements, and deltas across quality dimensions.',
    parameters: {
      type: 'object',
      properties: {
        baseline: {
          type: 'string',
          description: 'Path to the baseline session .jsonl file',
        },
        current: {
          type: 'string',
          description: 'Path to the current session .jsonl file',
        },
      },
      required: ['baseline', 'current'],
    },
    async execute(args: { baseline: string; current: string }) {
      const baselineSession = await parseSessionFile(args.baseline)
      const currentSession = await parseSessionFile(args.current)

      const baselineAnalysis = analyzeSession(baselineSession)
      const currentAnalysis = analyzeSession(currentSession)
      const comparison = compareSessions(baselineAnalysis, currentAnalysis)

      return [{ type: 'text', text: JSON.stringify(comparison, null, 2) }]
    },
  })
}

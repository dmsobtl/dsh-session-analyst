/**
 * Session comparison: detect regressions between a baseline and current session.
 */

import type { SessionAnalysis, TurnMetrics } from './analyzer.js'

export interface ComparisonResult {
  verdict: 'improved' | 'regressed' | 'unchanged'
  regressions: Regression[]
  improvements: Improvement[]
  delta: DeltaSummary
}

export interface Regression {
  dimension: string
  baseline: number
  current: number
  changePercent: number
  message: string
}

export interface Improvement {
  dimension: string
  baseline: number
  current: number
  changePercent: number
  message: string
}

export interface DeltaSummary {
  turnsDelta: number
  stepsDelta: number
  toolCallsDelta: number
  errorsDelta: number
  durationDelta: number
  tokenDelta: number
  efficiencyDelta: number
}

export function compareSessions(baseline: SessionAnalysis, current: SessionAnalysis): ComparisonResult {
  const regressions: Regression[] = []
  const improvements: Improvement[] = []

  const checks: Array<{
    dimension: string
    baselineVal: number
    currentVal: number
    higherIsBetter: boolean
    threshold: number
  }> = [
    {
      dimension: 'Tool success rate',
      baselineVal: baseline.summary.successRate,
      currentVal: current.summary.successRate,
      higherIsBetter: true,
      threshold: 0.05,
    },
    {
      dimension: 'Token efficiency',
      baselineVal: baseline.tokenStats.efficiency,
      currentVal: current.tokenStats.efficiency,
      higherIsBetter: true,
      threshold: 0.1,
    },
    {
      dimension: 'Total steps',
      baselineVal: baseline.summary.totalSteps,
      currentVal: current.summary.totalSteps,
      higherIsBetter: false,
      threshold: 0.2,
    },
    {
      dimension: 'Total errors',
      baselineVal: baseline.summary.totalErrors,
      currentVal: current.summary.totalErrors,
      higherIsBetter: false,
      threshold: 0.0,
    },
    {
      dimension: 'Duration (ms)',
      baselineVal: baseline.summary.totalDurationMs,
      currentVal: current.summary.totalDurationMs,
      higherIsBetter: false,
      threshold: 0.3,
    },
    {
      dimension: 'Total tokens consumed',
      baselineVal: baseline.tokenStats.totalInput + baseline.tokenStats.totalOutput,
      currentVal: current.tokenStats.totalInput + current.tokenStats.totalOutput,
      higherIsBetter: false,
      threshold: 0.2,
    },
  ]

  for (const check of checks) {
    if (check.baselineVal === 0 && check.currentVal === 0) continue
    const denom = check.baselineVal || 1
    const changePercent = (check.currentVal - check.baselineVal) / denom

    const isRegression = check.higherIsBetter
      ? changePercent < -check.threshold
      : changePercent > check.threshold

    const isImprovement = check.higherIsBetter
      ? changePercent > check.threshold
      : changePercent < -check.threshold

    if (isRegression) {
      regressions.push({
        dimension: check.dimension,
        baseline: check.baselineVal,
        current: check.currentVal,
        changePercent: Math.round(changePercent * 100),
        message: `${check.dimension}: ${formatVal(check.baselineVal)} → ${formatVal(check.currentVal)} (${changePercent > 0 ? '+' : ''}${Math.round(changePercent * 100)}%)`,
      })
    } else if (isImprovement) {
      improvements.push({
        dimension: check.dimension,
        baseline: check.baselineVal,
        current: check.currentVal,
        changePercent: Math.round(changePercent * 100),
        message: `${check.dimension}: ${formatVal(check.baselineVal)} → ${formatVal(check.currentVal)} (${changePercent > 0 ? '+' : ''}${Math.round(changePercent * 100)}%)`,
      })
    }
  }

  const verdict = regressions.length > 0
    ? 'regressed'
    : improvements.length > 0
      ? 'improved'
      : 'unchanged'

  return {
    verdict,
    regressions,
    improvements,
    delta: {
      turnsDelta: current.summary.totalTurns - baseline.summary.totalTurns,
      stepsDelta: current.summary.totalSteps - baseline.summary.totalSteps,
      toolCallsDelta: current.summary.totalToolCalls - baseline.summary.totalToolCalls,
      errorsDelta: current.summary.totalErrors - baseline.summary.totalErrors,
      durationDelta: current.summary.totalDurationMs - baseline.summary.totalDurationMs,
      tokenDelta: (current.tokenStats.totalInput + current.tokenStats.totalOutput)
        - (baseline.tokenStats.totalInput + baseline.tokenStats.totalOutput),
      efficiencyDelta: current.tokenStats.efficiency - baseline.tokenStats.efficiency,
    },
  }
}

function formatVal(val: number): string {
  if (val >= 1000) return `${(val / 1000).toFixed(1)}k`
  if (val < 1 && val > 0) return `${(val * 100).toFixed(1)}%`
  return String(Math.round(val))
}

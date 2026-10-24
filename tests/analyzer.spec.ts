import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { parseSessionContent, parseSessionFile } from '../src/parser.ts'
import { analyzeSession } from '../src/analyzer.ts'
import { compareSessions } from '../src/comparator.ts'

// Fixtures use the REAL DSH 0.2.x session log shapes:
//   - header carries `delegationDepth` and `agentPreset`
//   - `tool/result` carries a first-class tool-role message: call id at
//     `message.source.callId`, error flag at `message.isError`, and optional
//     failure identity at the event level `error`. Content blocks are flat.

const HEALTHY_SESSION = `{"type":"session","version":0,"id":"test-001","createdAt":1700000000000,"cwd":"E:\\\\work","delegationDepth":0,"agentPreset":"standard"}
{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}
{"type":"step/start","seq":2,"time":1001,"data":{"turn":1,"step":1}}
{"type":"tool/call","seq":3,"time":1100,"data":{"turn":1,"step":1,"callId":"c1","name":"pwsh","arguments":"{\\"command\\":\\"ls\\"}"}}
{"type":"tool/result","seq":4,"time":1500,"data":{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"c1"},"content":[{"type":"text","text":"file1.ts"}],"isError":false},"sourceEventSeqs":[3],"surfaceOp":"append"}}
{"type":"assistant/message","seq":5,"time":1600,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[]},"usage":{"inputTokens":100,"outputTokens":20,"reasoningTokens":10,"cacheReadTokens":0}}}
{"type":"step/end","seq":6,"time":1601,"data":{"turn":1,"step":1}}
{"type":"step/start","seq":7,"time":1700,"data":{"turn":1,"step":2}}
{"type":"tool/call","seq":8,"time":1800,"data":{"turn":1,"step":2,"callId":"c2","name":"read","arguments":"{\\"path\\":\\"file1.ts\\"}"}}
{"type":"tool/result","seq":9,"time":2000,"data":{"turn":1,"step":2,"message":{"role":"tool","source":{"kind":"tool","callId":"c2"},"content":[{"type":"text","text":"export function add(a,b){return a+b}"}],"isError":false}}}
{"type":"assistant/message","seq":10,"time":2100,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[]},"usage":{"inputTokens":150,"outputTokens":30,"reasoningTokens":0,"cacheReadTokens":0}}}
{"type":"step/end","seq":11,"time":2101,"data":{"turn":1,"step":2}}
{"type":"turn/end","seq":12,"time":2200,"data":{"turn":1,"reason":{"kind":"completed"}}}`

const ERROR_SESSION = `{"type":"session","version":0,"id":"test-002","createdAt":1700000000000,"cwd":"E:\\\\work","delegationDepth":0}
{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}
{"type":"step/start","seq":2,"time":1001,"data":{"turn":1,"step":1}}
{"type":"tool/call","seq":3,"time":1100,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\\"command\\":\\"rm -rf /\\"}"}}
{"type":"tool/result","seq":4,"time":1500,"data":{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"c1"},"content":[{"type":"text","text":"Permission denied"}],"isError":true},"error":{"name":"ToolError","code":"E_PERM","reason":"Permission denied"}}}
{"type":"assistant/message","seq":5,"time":1600,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[]},"usage":{"inputTokens":200,"outputTokens":50}}}
{"type":"step/end","seq":6,"time":1601,"data":{"turn":1,"step":1}}
{"type":"step/start","seq":7,"time":1700,"data":{"turn":1,"step":2}}
{"type":"tool/call","seq":8,"time":1800,"data":{"turn":1,"step":2,"callId":"c2","name":"bash","arguments":"{\\"command\\":\\"rm -rf /\\"}"}}
{"type":"tool/result","seq":9,"time":2000,"data":{"turn":1,"step":2,"message":{"role":"tool","source":{"kind":"tool","callId":"c2"},"content":[{"type":"text","text":"Permission denied"}],"isError":true},"error":{"name":"ToolError","code":"E_PERM","reason":"Permission denied"}}}
{"type":"assistant/message","seq":10,"time":2100,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[]},"usage":{"inputTokens":250,"outputTokens":40}}}
{"type":"step/end","seq":11,"time":2101,"data":{"turn":1,"step":2}}
{"type":"step/start","seq":12,"time":2200,"data":{"turn":1,"step":3}}
{"type":"tool/call","seq":13,"time":2300,"data":{"turn":1,"step":3,"callId":"c3","name":"bash","arguments":"{\\"command\\":\\"rm -rf /\\"}"}}
{"type":"tool/result","seq":14,"time":2500,"data":{"turn":1,"step":3,"message":{"role":"tool","source":{"kind":"tool","callId":"c3"},"content":[{"type":"text","text":"Permission denied"}],"isError":true},"error":{"name":"ToolError","code":"E_PERM","reason":"Permission denied"}}}
{"type":"assistant/message","seq":15,"time":2600,"data":{"turn":1,"step":3,"message":{"role":"assistant","content":[]},"usage":{"inputTokens":300,"outputTokens":10}}}
{"type":"step/end","seq":16,"time":2601,"data":{"turn":1,"step":3}}
{"type":"turn/end","seq":17,"time":2700,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"All attempts failed","code":"UNKNOWN"}}}}`

const OPEN_TURN_SESSION = `{"type":"session","version":0,"id":"test-003","createdAt":1700000000000,"delegationDepth":0}
{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}
{"type":"step/start","seq":2,"time":1001,"data":{"turn":1,"step":1}}
{"type":"tool/call","seq":3,"time":1100,"data":{"turn":1,"step":1,"callId":"c1","name":"pwsh","arguments":"{}"}}
{"type":"tool/result","seq":4,"time":1500,"data":{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"c1"},"content":[],"isError":false}}}
{"type":"text-chunks","seq0":5,"time0":1600,"members":[]}
{"type":"reasoning-chunks","seq0":6,"time0":1700,"members":[]}`

describe('parseSessionContent', () => {
  it('parses a real-format session header and event lines', () => {
    const session = parseSessionContent(HEALTHY_SESSION)
    expect(session.header.id).toBe('test-001')
    expect(session.header.delegationDepth).toBe(0)
    expect(session.events.length).toBe(12)
  })

  it('skips packed chunk rows (no event envelope)', () => {
    const session = parseSessionContent(OPEN_TURN_SESSION)
    expect(session.events.length).toBe(4) // turn/start, step/start, tool/call, tool/result
    expect(session.events.some((e) => e.type === 'text-chunks')).toBe(false)
  })
})

describe('analyzeSession', () => {
  it('computes correct summary metrics for a healthy session', () => {
    const analysis = analyzeSession(parseSessionContent(HEALTHY_SESSION))
    expect(analysis.summary.totalTurns).toBe(1)
    expect(analysis.summary.totalSteps).toBe(2)
    expect(analysis.summary.totalToolCalls).toBe(2)
    expect(analysis.summary.totalErrors).toBe(0)
    expect(analysis.summary.successRate).toBe(1)
  })

  it('attributes tools and computes token stats', () => {
    const analysis = analyzeSession(parseSessionContent(HEALTHY_SESSION))
    expect(analysis.toolStats.byName.pwsh.count).toBe(1)
    expect(analysis.toolStats.byName.read.count).toBe(1)
    expect(analysis.toolStats.byName.pwsh.errors).toBe(0)
    expect(analysis.tokenStats.totalInput).toBe(250)
    expect(analysis.tokenStats.totalOutput).toBe(50)
    expect(analysis.tokenStats.totalReasoning).toBe(10)
  })

  it('detects tool errors from the tool-role message', () => {
    const analysis = analyzeSession(parseSessionContent(ERROR_SESSION))
    expect(analysis.summary.totalErrors).toBe(3)
    expect(analysis.summary.successRate).toBe(0)
    expect(analysis.toolStats.byName.bash.errors).toBe(3)
    expect(analysis.toolStats.byName.bash.count).toBe(3)
  })

  it('detects redundant calls and high error rate', () => {
    const analysis = analyzeSession(parseSessionContent(ERROR_SESSION))
    expect(analysis.toolStats.redundantCalls.length).toBe(1)
    expect(analysis.toolStats.redundantCalls[0].name).toBe('bash')
    expect(analysis.toolStats.redundantCalls[0].occurrences).toBe(3)
    expect(analysis.issues.find((i) => i.code === 'HIGH_TOOL_ERROR_RATE')).toBeDefined()
    expect(analysis.issues.find((i) => i.code === 'REDUNDANT_TOOL_CALL')).toBeDefined()
  })

  it('emits a turn even when the session is still in progress', () => {
    const analysis = analyzeSession(parseSessionContent(OPEN_TURN_SESSION))
    expect(analysis.summary.totalTurns).toBe(1)
    expect(analysis.turns[0].endReason).toBe('in-progress')
    expect(analysis.summary.totalToolCalls).toBe(1)
  })

  it('honours the redundantCallThreshold option', () => {
    const analysis = analyzeSession(parseSessionContent(ERROR_SESSION), { redundantCallThreshold: 5 })
    expect(analysis.issues.find((i) => i.code === 'REDUNDANT_TOOL_CALL')).toBeUndefined()
  })
})

describe('parseSessionFile', () => {
  it('decodes a zstd-compressed session log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-session-analyst-'))
    const path = join(dir, 'session.jsonl.zstd')
    writeFileSync(path, zstdCompressSync(Buffer.from(HEALTHY_SESSION, 'utf8')))
    try {
      const session = await parseSessionFile(path)
      expect(session.header.id).toBe('test-001')
      expect(session.events.length).toBe(12)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('compareSessions', () => {
  it('detects regression when errors increase', () => {
    const baseline = analyzeSession(parseSessionContent(HEALTHY_SESSION))
    const current = analyzeSession(parseSessionContent(ERROR_SESSION))
    const comparison = compareSessions(baseline, current)
    expect(comparison.verdict).toBe('regressed')
    expect(comparison.regressions.find((r) => r.dimension === 'Total errors')).toBeDefined()
  })

  it('detects improvement when errors decrease', () => {
    const baseline = analyzeSession(parseSessionContent(ERROR_SESSION))
    const current = analyzeSession(parseSessionContent(HEALTHY_SESSION))
    const comparison = compareSessions(baseline, current)
    expect(comparison.verdict).toBe('improved')
    expect(comparison.improvements.length).toBeGreaterThan(0)
  })
})

import { describe, expect, it } from 'vitest'
import { parseSessionContent } from '../src/parser.ts'
import { analyzeSession } from '../src/analyzer.ts'
import { compareSessions } from '../src/comparator.ts'

const SAMPLE_SESSION = `{"type":"session","version":0,"id":"test-001","createdAt":1700000000000,"cwd":"/tmp/work"}
{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}
{"type":"step/start","seq":2,"time":1001,"data":{"turn":1,"step":1}}
{"type":"tool/call","seq":3,"time":1100,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\\"command\\":\\"ls -la\\"}"}}
{"type":"tool/result","seq":4,"time":1500,"data":{"turn":1,"step":1,"callId":"c1","content":[{"type":"text","text":"file1.ts"}],"isError":false}}
{"type":"assistant/message","seq":5,"time":1600,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"Found file1.ts"}]},"usage":{"inputTokens":100,"outputTokens":20}}}
{"type":"step/start","seq":6,"time":1700,"data":{"turn":1,"step":2}}
{"type":"tool/call","seq":7,"time":1800,"data":{"turn":1,"step":2,"callId":"c2","name":"read","arguments":"{\\"path\\":\\"/tmp/file1.ts\\"}"}}
{"type":"tool/result","seq":8,"time":2000,"data":{"turn":1,"step":2,"callId":"c2","content":[{"type":"text","text":"export function add(a,b){return a+b}"}],"isError":false}}
{"type":"assistant/message","seq":9,"time":2100,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"text","text":"I see the code."}]},"usage":{"inputTokens":150,"outputTokens":30}}}
{"type":"turn/end","seq":10,"time":2200,"data":{"turn":1,"reason":{"kind":"completed"}}}`

const SAMPLE_SESSION_WITH_ERRORS = `{"type":"session","version":0,"id":"test-002","createdAt":1700000000000,"cwd":"/tmp/work"}
{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}
{"type":"step/start","seq":2,"time":1001,"data":{"turn":1,"step":1}}
{"type":"tool/call","seq":3,"time":1100,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\\"command\\":\\"rm -rf /\\"}"}}
{"type":"tool/result","seq":4,"time":1500,"data":{"turn":1,"step":1,"callId":"c1","content":[{"type":"text","text":"Permission denied"}],"isError":true}}
{"type":"assistant/message","seq":5,"time":1600,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"Error occurred"}]},"usage":{"inputTokens":200,"outputTokens":50}}}
{"type":"step/start","seq":6,"time":1700,"data":{"turn":1,"step":2}}
{"type":"tool/call","seq":7,"time":1800,"data":{"turn":1,"step":2,"callId":"c2","name":"bash","arguments":"{\\"command\\":\\"rm -rf /\\"}"}}
{"type":"tool/result","seq":8,"time":2000,"data":{"turn":1,"step":2,"callId":"c2","content":[{"type":"text","text":"Permission denied"}],"isError":true}}
{"type":"assistant/message","seq":9,"time":2100,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"text","text":"Still failing"}]},"usage":{"inputTokens":250,"outputTokens":40}}}
{"type":"step/start","seq":10,"time":2200,"data":{"turn":1,"step":3}}
{"type":"tool/call","seq":11,"time":2300,"data":{"turn":1,"step":3,"callId":"c3","name":"bash","arguments":"{\\"command\\":\\"rm -rf /\\"}"}}
{"type":"tool/result","seq":12,"time":2500,"data":{"turn":1,"step":3,"callId":"c3","content":[{"type":"text","text":"Permission denied"}],"isError":true}}
{"type":"assistant/message","seq":13,"time":2600,"data":{"turn":1,"step":3,"message":{"role":"assistant","content":[{"type":"text","text":"Giving up"}]},"usage":{"inputTokens":300,"outputTokens":10}}}
{"type":"turn/end","seq":14,"time":2700,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"All attempts failed","code":"UNKNOWN"}}}}`

describe('parseSessionContent', () => {
  it('parses a valid session file', () => {
    const session = parseSessionContent(SAMPLE_SESSION)
    expect(session.header.id).toBe('test-001')
    expect(session.header.createdAt).toBe(1700000000000)
    expect(session.events.length).toBe(10)
  })
})

describe('analyzeSession', () => {
  it('computes correct summary metrics for a healthy session', () => {
    const session = parseSessionContent(SAMPLE_SESSION)
    const analysis = analyzeSession(session)

    expect(analysis.summary.totalTurns).toBe(1)
    expect(analysis.summary.totalSteps).toBe(2)
    expect(analysis.summary.totalToolCalls).toBe(2)
    expect(analysis.summary.totalErrors).toBe(0)
    expect(analysis.summary.successRate).toBe(1)
  })

  it('computes token stats', () => {
    const session = parseSessionContent(SAMPLE_SESSION)
    const analysis = analyzeSession(session)

    expect(analysis.tokenStats.totalInput).toBe(250)
    expect(analysis.tokenStats.totalOutput).toBe(50)
  })

  it('detects tool errors and redundant calls', () => {
    const session = parseSessionContent(SAMPLE_SESSION_WITH_ERRORS)
    const analysis = analyzeSession(session)

    expect(analysis.summary.totalErrors).toBe(3)
    expect(analysis.summary.successRate).toBe(0)
    expect(analysis.toolStats.byName['bash'].errors).toBe(3)

    const redundant = analysis.toolStats.redundantCalls
    expect(redundant.length).toBe(1)
    expect(redundant[0].name).toBe('bash')
    expect(redundant[0].occurrences).toBe(3)
  })

  it('generates issues for high error rate', () => {
    const session = parseSessionContent(SAMPLE_SESSION_WITH_ERRORS)
    const analysis = analyzeSession(session)

    const highErrorIssue = analysis.issues.find(i => i.code === 'HIGH_TOOL_ERROR_RATE')
    expect(highErrorIssue).toBeDefined()
    expect(highErrorIssue?.severity).toBe('error')
  })

  it('generates issues for redundant calls', () => {
    const session = parseSessionContent(SAMPLE_SESSION_WITH_ERRORS)
    const analysis = analyzeSession(session)

    const redundantIssue = analysis.issues.find(i => i.code === 'REDUNDANT_TOOL_CALL')
    expect(redundantIssue).toBeDefined()
  })
})

describe('compareSessions', () => {
  it('detects regression when errors increase', () => {
    const baseline = analyzeSession(parseSessionContent(SAMPLE_SESSION))
    const current = analyzeSession(parseSessionContent(SAMPLE_SESSION_WITH_ERRORS))

    const comparison = compareSessions(baseline, current)
    expect(comparison.verdict).toBe('regressed')
    expect(comparison.regressions.length).toBeGreaterThan(0)

    const errorRegression = comparison.regressions.find(r => r.dimension === 'Total errors')
    expect(errorRegression).toBeDefined()
  })

  it('detects improvement when errors decrease', () => {
    const baseline = analyzeSession(parseSessionContent(SAMPLE_SESSION_WITH_ERRORS))
    const current = analyzeSession(parseSessionContent(SAMPLE_SESSION))

    const comparison = compareSessions(baseline, current)
    expect(comparison.verdict).toBe('improved')
    expect(comparison.improvements.length).toBeGreaterThan(0)
  })
})

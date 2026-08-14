# dsh-session-analyst

Session quality analysis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Gives the agent (and you) structured insight into session behavior: tool success rates, token efficiency, redundant calls, error patterns, and regression detection.

## Install

```bash
dsh plugin add dsh-session-analyst
```

Or add to your `cordis.patch.yml`:

```yaml
- id: session-analyst
  plugin: dsh-session-analyst
  config:
    redundantCallThreshold: 3
    excessiveStepThreshold: 10
```

## Tools provided

### `analyze_session`

Parse a session JSONL file and return quality metrics.

```
Agent: I'll analyze the session from the last run.
→ analyze_session({ path: "~/.dsh/sessions/abc123/session.jsonl" })

Returns:
{
  "summary": {
    "totalTurns": 5,
    "totalSteps": 12,
    "totalToolCalls": 8,
    "totalErrors": 1,
    "successRate": 0.875,
    "avgStepsPerTurn": 2.4
  },
  "issues": [
    { "severity": "warning", "code": "REDUNDANT_TOOL_CALL", "message": "..." }
  ],
  "tokenStats": { "efficiency": 0.12, ... },
  "toolStats": { "byName": { "bash": { "count": 5, "errors": 1 }, ... } }
}
```

### `compare_sessions`

Compare baseline vs current session to detect regressions.

```
Agent: Compare today's run against yesterday's baseline.
→ compare_sessions({ baseline: "./baseline.jsonl", current: "./today.jsonl" })

Returns:
{
  "verdict": "regressed",
  "regressions": [
    { "dimension": "Tool success rate", "baseline": "100%", "current": "75%", "changePercent": -25 }
  ],
  "delta": { "stepsDelta": +3, "errorsDelta": +2, "tokenDelta": +1500 }
}
```

## Analysis dimensions

| Dimension | What it detects |
|-----------|----------------|
| Tool success rate | Percentage of tool calls that return without error |
| Redundant calls | Same tool + same arguments called multiple times |
| Token efficiency | Ratio of output tokens to total consumed |
| Excessive steps | Turns with >10 steps (possible loop) |
| Error patterns | Tools with >50% error rate |
| Duration | Wall-clock time per turn |

## Use cases

- **Post-run diagnostics**: Agent analyzes its own session after a task to identify inefficiencies
- **Regression detection**: Compare sessions before/after a prompt or skill change
- **CI integration**: Headless mode runs a task, then analyze_session checks quality gates
- **Skill tuning**: Identify which tools are being misused and refine system prompts

## Standalone usage (without dsh)

The parser and analyzer are usable as a library:

```typescript
import { parseSessionFile, analyzeSession, compareSessions } from 'dsh-session-analyst'

const session = await parseSessionFile('./session.jsonl')
const analysis = analyzeSession(session)
console.log(analysis.summary)
```

## Development

```bash
npm install
npm test
```

## License

MIT

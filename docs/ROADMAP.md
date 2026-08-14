# Roadmap

## v0.1 — Session Analysis (current)

- [x] JSONL session parser
- [x] Turn/step/tool metrics extraction
- [x] Redundant call detection
- [x] Error pattern analysis
- [x] Token efficiency calculation
- [x] Session comparison / regression detection
- [x] dsh tool registration (analyze_session, compare_sessions)

## v0.2 — Live Monitoring

- [ ] `session/event` listener for real-time quality tracking
- [ ] Per-turn quality score (composite of efficiency, errors, redundancy)
- [ ] Threshold-based alerts (inject warning when quality drops)
- [ ] Live dashboard data via session projections

## v0.3 — Baseline Management

- [ ] Auto-save analysis results as baseline
- [ ] Configurable quality gates (fail if success rate < X)
- [ ] Historical trend storage (per-task quality over time)
- [ ] CI-friendly exit codes

## v0.4 — Pattern Library

- [ ] Detect "retry storm" (same error, same fix attempt, 3+ rounds)
- [ ] Detect "context overflow" (compaction triggered, then repeated info re-read)
- [ ] Detect "wrong tool" (bash used where read/edit would suffice)
- [ ] Detect "premature conclusion" (turn ends before task completion signals)
- [ ] Configurable custom patterns via YAML rules

## Future — Electron & Desktop App Testing

Playwright supports `_electron.launch()` natively:

```typescript
import { _electron as electron } from 'playwright'

const app = await electron.launch({ args: ['main.js'] })
const window = await app.firstWindow()

// Drive the app like a browser page
await window.click('[data-testid="submit"]')
const text = await window.textContent('.result')
```

This enables:
- Testing Electron-based desktop apps (VS Code extensions, internal tools)
- Accessing both renderer (DOM) and main process (Node.js) contexts
- IPC channel inspection between processes
- No vision model needed — direct DOM/accessibility tree access

Could become a `dsh-tool-electron-verify` plugin that pairs with `dsh-session-analyst`
for end-to-end desktop application testing.

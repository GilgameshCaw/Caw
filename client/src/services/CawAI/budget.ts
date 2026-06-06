// CawAI/budget.ts
//
// Daily USD spend tracker. Hard circuit-breaker on the operator's
// Anthropic bill.
//
// Why this exists: if the notification-tip-gate ever misfires (bug,
// wrong threshold, validator skipping the gate), nothing else stops
// an attacker from spamming the bot with free mentions and watching
// the operator's inference bill spike. The budget cap is the
// independent safety net.
//
// State persists across restarts via a JSONL log at the path provided.
// Resets at UTC midnight. Simple by design — no DB dependency, no
// shared state across replicas (each replica caps independently,
// which over-counts safe budget rather than under-counts).

import { promises as fs } from 'fs'
import path from 'path'

type DayState = {
  date: string       // YYYY-MM-DD UTC
  usdSpent: number
}

export class BudgetTracker {
  private state: DayState
  private readonly path: string
  private readonly dailyCapUsd: number

  constructor(statePath: string, dailyCapUsd: number) {
    this.path = statePath
    this.dailyCapUsd = dailyCapUsd
    this.state = { date: today(), usdSpent: 0 }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as DayState
      this.state = parsed.date === today() ? parsed : { date: today(), usdSpent: 0 }
    } catch {
      // first-run; state already defaulted
    }
  }

  async record(usd: number): Promise<void> {
    if (this.state.date !== today()) {
      this.state = { date: today(), usdSpent: 0 }
    }
    this.state.usdSpent += usd
    await fs.mkdir(path.dirname(this.path), { recursive: true }).catch(() => {})
    await fs.writeFile(this.path, JSON.stringify(this.state))
  }

  hasBudget(): boolean {
    if (this.state.date !== today()) return true // new day, reset implicit
    return this.state.usdSpent < this.dailyCapUsd
  }

  remaining(): number {
    if (this.state.date !== today()) return this.dailyCapUsd
    return Math.max(0, this.dailyCapUsd - this.state.usdSpent)
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Budget spend sink (epic AIPP-11, subtask 11.2).
 *
 * Records spend from lifecycle events into the single {@link BudgetManager}
 * ledger. Superseded fallback attempts arrive as attempt-final events and the
 * winning (or final-error) attempt as the logical-request event -- each attempt
 * fires exactly one of the two, so spend is counted once per upstream call with
 * no double-counting across the two legacy trackers this unifies.
 */

import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import type { BudgetManager } from './budget.js';

export class BudgetSink implements UsageEventSink {
  readonly name = 'budget';

  constructor(private readonly manager: BudgetManager) {}

  onAttemptFinal(event: CanonicalUsageEvent): void {
    this.manager.recordEvent(event);
  }

  onLogicalRequestFinal(event: CanonicalUsageEvent): void {
    this.manager.recordEvent(event);
  }
}

/**
 * Anomaly-alert sink (epic AIPP-11, subtask 11.3).
 *
 * A lifecycle consumer that feeds each completed logical request to the anomaly
 * detector and fires an alert for anything it surfaces. Best-effort and
 * content-free: it reads only token counts and the cost estimate from the
 * canonical event, never prompt or response content.
 */

import type { UsageEventSink } from '../../lifecycle/event-sinks.js';
import type { CanonicalUsageEvent } from '../../lifecycle/usage-event.js';
import { estimateCostFromTokens } from '../budget/budget.js';
import type { AnomalyDetector } from '../anomaly/detector.js';
import type { AlertManager } from './manager.js';

export class AnomalyAlertSink implements UsageEventSink {
  readonly name = 'anomaly-alerts';

  constructor(
    private readonly detector: AnomalyDetector,
    private readonly alerts: AlertManager,
  ) {}

  onLogicalRequestFinal(event: CanonicalUsageEvent): void {
    const costUsd =
      event.costEstimateUsd ??
      estimateCostFromTokens(
        event.nativeModel,
        event.inputTokens,
        event.outputTokens,
      );
    const result = this.detector.recordAndAnalyze({
      model: event.nativeModel,
      tokensIn: event.inputTokens,
      tokensOut: event.outputTokens,
      costUsd,
    });
    for (const anomaly of result.anomalies) {
      this.alerts.fireAnomaly(anomaly);
    }
  }
}

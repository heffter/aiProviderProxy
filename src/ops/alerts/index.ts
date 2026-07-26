/**
 * Alerts (epic AIPP-11, subtask 11.3).
 */

export {
  AlertManager,
  DEFAULT_ALERTS_CONFIG,
  type Alert,
  type AlertType,
  type AlertSeverity,
  type AlertsConfig,
  type AlertManagerOptions,
  type WebhookDeliver,
} from './manager.js';

export { AnomalyAlertSink } from './sink.js';

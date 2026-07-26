/**
 * Alert manager (epic AIPP-11, subtask 11.3; FR-IDENT-006).
 *
 * Records threshold / anomaly / breach alerts to alerts.db, with per-key
 * cooldown deduplication and optional delivery to a USER-configured webhook.
 * The only network egress is that opt-in webhook (default unset); the manager
 * never contacts any first-party endpoint. Disabled by default. Clock, database,
 * and webhook delivery are injectable for deterministic tests.
 */

import Database from 'better-sqlite3';
import { dataFile } from '../trackers/paths.js';
import type { AnomalyDetail } from '../anomaly/detector.js';

/** A kind of alert. */
export type AlertType = 'threshold' | 'anomaly' | 'breach';

/** Alert severity. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** A recorded alert. */
export interface Alert {
  id: string;
  type: AlertType;
  message: string;
  severity: AlertSeverity;
  timestamp: number;
  data: Record<string, unknown>;
  delivered: boolean;
}

/** Alert manager configuration. */
export interface AlertsConfig {
  enabled: boolean;
  /** Opt-in user webhook; the only egress. Unset means no delivery. */
  webhookUrl?: string;
  /** Per-key dedup cooldown in ms. */
  cooldownMs: number;
  /** Maximum retained alerts. */
  maxHistory: number;
}

/** The default alerts configuration (disabled). */
export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  enabled: false,
  cooldownMs: 300_000,
  maxHistory: 500,
};

/** Delivers an alert payload to a webhook URL. */
export type WebhookDeliver = (url: string, payload: unknown) => Promise<void>;

const defaultDeliver: WebhookDeliver = async (url, payload) => {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
};

export interface AlertManagerOptions {
  dir?: string;
  database?: Database.Database;
  now?: () => number;
  /** Webhook delivery (injected in tests); defaults to a fetch POST. */
  deliver?: WebhookDeliver;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(timestamp);`;

export class AlertManager {
  private config: AlertsConfig;
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly deliver: WebhookDeliver;
  private readonly dedup = new Map<string, number>();
  private counter = 0;

  constructor(
    config: AlertsConfig = DEFAULT_ALERTS_CONFIG,
    options: AlertManagerOptions = {},
  ) {
    this.config = config;
    this.now = options.now ?? Date.now;
    this.deliver = options.deliver ?? defaultDeliver;
    this.db =
      options.database ?? new Database(dataFile('alerts.db', options.dir));
    this.db.exec(SCHEMA);
    // Prune alerts older than seven days on open.
    this.db
      .prepare('DELETE FROM alerts WHERE timestamp < ?')
      .run(this.now() - 7 * 24 * 60 * 60 * 1000);
  }

  updateConfig(config: AlertsConfig): void {
    this.config = config;
  }

  getConfig(): AlertsConfig {
    return { ...this.config };
  }

  /** Fire a budget-threshold alert (percent of a limit crossed). */
  fireThreshold(
    threshold: number,
    currentPercent: number,
    currentSpend: number,
    limit: number,
  ): Alert | null {
    if (!this.config.enabled || this.isDuplicate(`threshold:${threshold}`)) {
      return null;
    }
    const severity: AlertSeverity =
      threshold >= 95 ? 'critical' : threshold >= 80 ? 'warning' : 'info';
    return this.createAlert(
      'threshold',
      `Budget ${threshold}% threshold crossed (${currentPercent.toFixed(1)}% used: $${currentSpend.toFixed(2)} / $${limit})`,
      severity,
      { threshold, currentPercent, currentSpend, limit },
    );
  }

  /** Fire an anomaly alert from a detector result. */
  fireAnomaly(anomaly: AnomalyDetail): Alert | null {
    if (!this.config.enabled || this.isDuplicate(`anomaly:${anomaly.type}`)) {
      return null;
    }
    return this.createAlert(
      'anomaly',
      `Anomaly detected: ${anomaly.message}`,
      anomaly.severity === 'critical' ? 'critical' : 'warning',
      { anomalyType: anomaly.type, ...anomaly.data },
    );
  }

  /** Fire a budget-breach alert (a limit was exceeded). */
  fireBreach(
    breachType: string,
    currentSpend: number,
    limit: number,
  ): Alert | null {
    if (!this.config.enabled || this.isDuplicate(`breach:${breachType}`)) {
      return null;
    }
    return this.createAlert(
      'breach',
      `Budget breach: ${breachType} limit exceeded ($${currentSpend.toFixed(2)} / $${limit})`,
      'critical',
      { breachType, currentSpend, limit },
    );
  }

  /** The most recent alerts, newest first. */
  getRecent(limit = 20): Alert[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, message, severity, timestamp, data, delivered
         FROM alerts ORDER BY timestamp DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      type: string;
      message: string;
      severity: string;
      timestamp: number;
      data: string;
      delivered: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      type: r.type as AlertType,
      message: r.message,
      severity: r.severity as AlertSeverity,
      timestamp: r.timestamp,
      data: JSON.parse(r.data) as Record<string, unknown>,
      delivered: r.delivered === 1,
    }));
  }

  /** Alert counts by type. */
  getCounts(): Record<AlertType, number> {
    const counts: Record<AlertType, number> = {
      threshold: 0,
      anomaly: 0,
      breach: 0,
    };
    const rows = this.db
      .prepare('SELECT type, COUNT(*) AS c FROM alerts GROUP BY type')
      .all() as Array<{ type: string; c: number }>;
    for (const r of rows) {
      if (r.type in counts) {
        counts[r.type as AlertType] = r.c;
      }
    }
    return counts;
  }

  close(): void {
    this.db.close();
  }

  private isDuplicate(key: string): boolean {
    const last = this.dedup.get(key);
    const nowMs = this.now();
    if (last !== undefined && nowMs - last < this.config.cooldownMs) {
      return true;
    }
    this.dedup.set(key, nowMs);
    return false;
  }

  private createAlert(
    type: AlertType,
    message: string,
    severity: AlertSeverity,
    data: Record<string, unknown>,
  ): Alert {
    const ts = this.now();
    const alert: Alert = {
      id: `alert-${(this.counter += 1)}-${ts}`,
      type,
      message,
      severity,
      timestamp: ts,
      data,
      delivered: false,
    };
    this.store(alert);
    this.sendWebhook(alert);
    return alert;
  }

  private store(alert: Alert): void {
    this.db
      .prepare(
        `INSERT INTO alerts (id, type, message, severity, timestamp, data, delivered)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.id,
        alert.type,
        alert.message,
        alert.severity,
        alert.timestamp,
        JSON.stringify(alert.data),
        alert.delivered ? 1 : 0,
      );
    const { c } = this.db.prepare('SELECT COUNT(*) AS c FROM alerts').get() as {
      c: number;
    };
    if (c > this.config.maxHistory) {
      this.db
        .prepare(
          `DELETE FROM alerts WHERE id IN (
             SELECT id FROM alerts ORDER BY timestamp ASC LIMIT ?
           )`,
        )
        .run(c - this.config.maxHistory);
    }
  }

  private sendWebhook(alert: Alert): void {
    if (!this.config.webhookUrl) {
      return;
    }
    const payload = {
      source: 'aiproviderproxy',
      alert: {
        id: alert.id,
        type: alert.type,
        message: alert.message,
        severity: alert.severity,
        timestamp: new Date(alert.timestamp).toISOString(),
        data: alert.data,
      },
    };
    // Fire and forget: delivery failure must never affect the request path.
    void this.deliver(this.config.webhookUrl, payload)
      .then(() => {
        try {
          this.db
            .prepare('UPDATE alerts SET delivered = 1 WHERE id = ?')
            .run(alert.id);
        } catch {
          // best-effort delivery flag
        }
      })
      .catch(() => {
        // non-fatal
      });
  }
}

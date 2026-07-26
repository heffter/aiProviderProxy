/**
 * Response cache (epic AIPP-11, subtask 11.4; FR-IDENT-006, NFR-PRIV-003).
 *
 * Exact-match caching keyed by a SHA-256 over the canonical request fields that
 * affect the response (model, system, messages, tools, sampling params). The
 * cached body is gzip-compressed and stored in a SQLite index with a TTL and a
 * size budget (LRU-ish eviction of the oldest entries). Only deterministic
 * requests are cached by default (temperature unset or 0), so a cache hit is a
 * faithful replay. A cache hit consumed no provider tokens, so the caller emits
 * a local-only event that is excluded from Tokemetry export.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { dataFile } from '../trackers/paths.js';

/** Request fields that affect the response and so key the cache. */
export const CACHE_KEY_FIELDS = [
  'max_tokens',
  'messages',
  'model',
  'stop_sequences',
  'system',
  'temperature',
  'tool_choice',
  'tools',
  'top_k',
  'top_p',
] as const;

/** SHA-256 cache key over the canonical (sorted) request fields. */
export function computeCacheKey(body: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const field of CACHE_KEY_FIELDS) {
    if (body[field] !== undefined) {
      canonical[field] = body[field];
    }
  }
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(canonical).sort()) {
    ordered[k] = canonical[k];
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** True when a request is deterministic (temperature unset, null, or 0). */
export function isDeterministic(body: Record<string, unknown>): boolean {
  const temp = body.temperature;
  return temp === undefined || temp === null || temp === 0;
}

/** Response-cache configuration. */
export interface CacheConfig {
  enabled: boolean;
  /** Maximum on-disk cache size in MB before eviction. */
  maxSizeMb: number;
  /** Default entry TTL in seconds. */
  defaultTtlSeconds: number;
  /** Cache only deterministic requests (temperature 0/unset). */
  onlyWhenDeterministic: boolean;
}

/** The default cache configuration (enabled). */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  enabled: true,
  maxSizeMb: 100,
  defaultTtlSeconds: 3600,
  onlyWhenDeterministic: true,
};

/** Cache counters. */
export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  sizeBytes: number;
}

export interface ResponseCacheOptions {
  dir?: string;
  database?: Database.Database;
  now?: () => number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_entries (
  hash TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  body BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_created ON cache_entries(created_at);`;

export class ResponseCache {
  private config: CacheConfig;
  private readonly db: Database.Database;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(
    config: CacheConfig = DEFAULT_CACHE_CONFIG,
    options: ResponseCacheOptions = {},
  ) {
    this.config = config;
    this.now = options.now ?? Date.now;
    if (options.database) {
      this.db = options.database;
    } else {
      const path = dataFile('cache/index.db', options.dir);
      mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path);
    }
    this.db.exec(SCHEMA);
  }

  updateConfig(config: CacheConfig): void {
    this.config = config;
  }

  /**
   * Whether a request should skip the cache entirely: disabled, or a
   * non-deterministic request when only deterministic caching is allowed.
   */
  shouldBypass(body: Record<string, unknown>): boolean {
    if (!this.config.enabled) {
      return true;
    }
    return this.config.onlyWhenDeterministic && !isDeterministic(body);
  }

  /** A cached response body for a key, or undefined on miss/expiry. */
  get(key: string): unknown | undefined {
    const row = this.db
      .prepare('SELECT body, expires_at FROM cache_entries WHERE hash = ?')
      .get(key) as { body: Buffer; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) {
      if (row) {
        this.db.prepare('DELETE FROM cache_entries WHERE hash = ?').run(key);
      }
      this.misses += 1;
      return undefined;
    }
    this.db
      .prepare(
        'UPDATE cache_entries SET hit_count = hit_count + 1 WHERE hash = ?',
      )
      .run(key);
    this.hits += 1;
    return JSON.parse(gunzipSync(row.body).toString('utf8')) as unknown;
  }

  /** Store a response body under a key, then evict to the size budget. */
  set(key: string, model: string, body: unknown, ttlSeconds?: number): void {
    if (!this.config.enabled) {
      return;
    }
    const gz = gzipSync(Buffer.from(JSON.stringify(body), 'utf8'));
    const nowMs = this.now();
    const ttl = (ttlSeconds ?? this.config.defaultTtlSeconds) * 1000;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cache_entries
           (hash, model, body, size, created_at, expires_at, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(key, model, gz, gz.length, nowMs, nowMs + ttl);
    this.evict();
  }

  private evict(): void {
    const budget = this.config.maxSizeMb * 1_000_000;
    let total = this.totalSize();
    if (total <= budget) {
      return;
    }
    const rows = this.db
      .prepare('SELECT hash, size FROM cache_entries ORDER BY created_at ASC')
      .all() as Array<{ hash: string; size: number }>;
    for (const row of rows) {
      if (total <= budget) {
        break;
      }
      this.db.prepare('DELETE FROM cache_entries WHERE hash = ?').run(row.hash);
      total -= row.size;
    }
  }

  private totalSize(): number {
    const { s } = this.db
      .prepare('SELECT COALESCE(SUM(size), 0) AS s FROM cache_entries')
      .get() as { s: number };
    return s;
  }

  getStats(): CacheStats {
    const { c } = this.db
      .prepare('SELECT COUNT(*) AS c FROM cache_entries')
      .get() as { c: number };
    return {
      entries: c,
      hits: this.hits,
      misses: this.misses,
      sizeBytes: this.totalSize(),
    };
  }

  /** Remove every entry. */
  clear(): void {
    this.db.prepare('DELETE FROM cache_entries').run();
  }

  close(): void {
    this.db.close();
  }
}

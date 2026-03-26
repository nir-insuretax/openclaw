/**
 * SQLite-backed call log store for Norma outbound calls.
 * AI-368: Norma Outbound Voice Calling MVP
 *
 * Stores call logs, processed webhook IDs (idempotency),
 * and DNC list entries.
 */

import Database from "better-sqlite3";
import type { CallOutcome, TranscriptEntry } from "./types.js";

export interface CallLogEntry {
  callId: string;
  hubspotContactId: string;
  phone: string;
  disposition: string;
  durationSeconds: number;
  qualityScore: number;
  hubspotCallId: string;
  hubspotNoteId: string;
  transcript: string; // JSON-serialized TranscriptEntry[]
  summary: string;
  createdAt: string;
}

export interface LogCallParams {
  callId: string;
  hubspotContactId: string;
  phone: string;
  durationSeconds: number;
  outcome: CallOutcome;
  transcript: TranscriptEntry[];
  hubspotCallId: string;
  hubspotNoteId: string;
}

export class CallStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS call_log (
        call_id TEXT PRIMARY KEY,
        hubspot_contact_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        disposition TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        quality_score INTEGER NOT NULL,
        hubspot_call_id TEXT,
        hubspot_note_id TEXT,
        transcript TEXT,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS processed_webhooks (
        call_id TEXT PRIMARY KEY,
        processed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS dnc_list (
        phone TEXT PRIMARY KEY,
        reason TEXT,
        source TEXT,
        added_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_call_log_created ON call_log(created_at DESC);
    `);
  }

  logCall(params: LogCallParams): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO call_log
        (call_id, hubspot_contact_id, phone, disposition, duration_seconds,
         quality_score, hubspot_call_id, hubspot_note_id, transcript, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.callId,
        params.hubspotContactId,
        params.phone,
        params.outcome.disposition,
        params.durationSeconds,
        params.outcome.qualityScore,
        params.hubspotCallId,
        params.hubspotNoteId,
        JSON.stringify(params.transcript),
        params.outcome.summary,
      );
  }

  getCallLog(callId: string): CallLogEntry | undefined {
    return this.db
      .prepare(
        `SELECT call_id as callId, hubspot_contact_id as hubspotContactId,
         phone, disposition, duration_seconds as durationSeconds,
         quality_score as qualityScore, hubspot_call_id as hubspotCallId,
         hubspot_note_id as hubspotNoteId, transcript, summary,
         created_at as createdAt
         FROM call_log WHERE call_id = ?`,
      )
      .get(callId) as CallLogEntry | undefined;
  }

  getRecentCalls(limit: number = 20): CallLogEntry[] {
    return this.db
      .prepare(
        `SELECT call_id as callId, hubspot_contact_id as hubspotContactId,
         phone, disposition, duration_seconds as durationSeconds,
         quality_score as qualityScore, hubspot_call_id as hubspotCallId,
         hubspot_note_id as hubspotNoteId, transcript, summary,
         created_at as createdAt
         FROM call_log ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as CallLogEntry[];
  }

  isWebhookProcessed(callId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM processed_webhooks WHERE call_id = ?").get(callId);
  }

  markWebhookProcessed(callId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO processed_webhooks (call_id) VALUES (?)").run(callId);
  }

  isOnDncList(phone: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM dnc_list WHERE phone = ?").get(phone);
  }

  addToDncList(phone: string, reason: string, source: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO dnc_list (phone, reason, source) VALUES (?, ?, ?)")
      .run(phone, reason, source);
  }

  close(): void {
    this.db.close();
  }
}

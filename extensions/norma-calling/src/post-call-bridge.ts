/**
 * Post-call processing bridge — monitors voice-call JSONL store for completed
 * calls and runs the PostCallProcessor pipeline (outcome analysis, HubSpot
 * logging, transcript storage, DNC updates).
 *
 * AI-368 Phase 2: Conversational AI + CRM + Transcripts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallStore } from "./call-store.js";
import { HubSpotCallLogger } from "./hubspot-logger.js";
import { PostCallProcessor } from "./post-call-processor.js";
import type { PostCallData, TranscriptEntry } from "./types.js";

/** Shape of a voice-call CallRecord from the JSONL store */
interface VoiceCallRecord {
  callId: string;
  providerCallId?: string;
  provider: string;
  direction: "outbound" | "inbound";
  state: string;
  from: string;
  to: string;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  endReason?: string;
  transcript: Array<{
    timestamp: number;
    speaker: "bot" | "user";
    text: string;
    isFinal?: boolean;
  }>;
  metadata?: Record<string, unknown>;
}

const TERMINAL_STATES = new Set([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);

const DEFAULT_VOICE_CALLS_DIR = path.join(os.homedir(), ".openclaw", "voice-calls");
const DEFAULT_DB_PATH = path.join(os.homedir(), ".openclaw", "norma-calls", "norma-calls.sqlite");

/**
 * Convert voice-call transcript format (speaker: "bot"|"user")
 * to norma-calling format (speaker: "agent"|"user").
 */
function convertTranscript(vcTranscript: VoiceCallRecord["transcript"]): TranscriptEntry[] {
  return vcTranscript.map((entry) => ({
    speaker: entry.speaker === "bot" ? "agent" : "user",
    text: entry.text,
    timestamp: entry.timestamp,
  }));
}

/**
 * Read all call records from the voice-calls JSONL store.
 */
function readVoiceCallRecords(voiceCallsDir: string): VoiceCallRecord[] {
  const jsonlPath = path.join(voiceCallsDir, "calls.jsonl");
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }

  const content = fs.readFileSync(jsonlPath, "utf-8");
  const records: VoiceCallRecord[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

/**
 * Find completed calls that haven't been processed by norma-calling yet.
 */
export function findUnprocessedCalls(params: {
  voiceCallsDir?: string;
  dbPath?: string;
}): Array<{ record: VoiceCallRecord; postCallData: PostCallData }> {
  const voiceCallsDir = params.voiceCallsDir ?? DEFAULT_VOICE_CALLS_DIR;
  const dbPath = params.dbPath ?? DEFAULT_DB_PATH;

  const records = readVoiceCallRecords(voiceCallsDir);

  // Build a map of latest state per callId (JSONL may have multiple entries per call)
  const latestByCallId = new Map<string, VoiceCallRecord>();
  for (const record of records) {
    latestByCallId.set(record.callId, record);
  }

  // Filter to completed outbound calls not yet processed
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const store = new CallStore(dbPath);

  const unprocessed: Array<{ record: VoiceCallRecord; postCallData: PostCallData }> = [];

  for (const [, record] of latestByCallId) {
    if (record.direction !== "outbound") continue;
    if (!TERMINAL_STATES.has(record.state)) continue;
    if (store.isWebhookProcessed(record.callId)) continue;

    const durationSeconds =
      record.endedAt && record.answeredAt
        ? Math.round((record.endedAt - record.answeredAt) / 1000)
        : record.endedAt && record.startedAt
          ? Math.round((record.endedAt - record.startedAt) / 1000)
          : 0;

    const postCallData: PostCallData = {
      callId: record.callId,
      transcript: convertTranscript(record.transcript),
      durationSeconds,
      analysis: {
        callSuccessful: !["failed", "error", "no-answer", "busy"].includes(record.state),
      },
    };

    unprocessed.push({ record, postCallData });
  }

  store.close();
  return unprocessed;
}

/**
 * Process all unprocessed completed calls.
 */
export async function processCompletedCalls(params: {
  hubspotClient: any;
  voiceCallsDir?: string;
  dbPath?: string;
}): Promise<Array<{ callId: string; phone: string; disposition: string; hubspotStatus: string }>> {
  const { hubspotClient } = params;
  const dbPath = params.dbPath ?? DEFAULT_DB_PATH;

  const unprocessed = findUnprocessedCalls(params);
  if (unprocessed.length === 0) {
    return [];
  }

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const store = new CallStore(dbPath);
  const hubspotLogger = new HubSpotCallLogger(hubspotClient);
  const processor = new PostCallProcessor(store, hubspotLogger);
  const results: Array<{
    callId: string;
    phone: string;
    disposition: string;
    hubspotStatus: string;
  }> = [];

  for (const { record, postCallData } of unprocessed) {
    try {
      // Try to find HubSpot contact by phone number
      let hubspotContactId = "unknown";
      try {
        const searchResult = await hubspotClient.crm.contacts.searchApi.doSearch({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: "phone",
                  operator: "EQ",
                  value: record.to,
                },
              ],
            },
          ],
          properties: ["firstname", "lastname", "phone"],
          limit: 1,
        });
        if (searchResult.results?.length > 0) {
          hubspotContactId = searchResult.results[0].id;
        }
      } catch {
        // Contact lookup failed, proceed with "unknown"
      }

      const result = await processor.process({
        postCallData,
        hubspotContactId,
        phone: record.to,
      });

      results.push({
        callId: record.callId,
        phone: record.to,
        disposition: result.outcome.disposition,
        hubspotStatus: result.hubspotResult.status,
      });

      console.log(
        `[norma-calling] Processed call ${record.callId}: ${result.outcome.disposition} → HubSpot ${result.hubspotResult.status}`,
      );
    } catch (err) {
      console.error(`[norma-calling] Failed to process call ${record.callId}:`, err);
      results.push({
        callId: record.callId,
        phone: record.to,
        disposition: "error",
        hubspotStatus: "failed",
      });
    }
  }

  store.close();
  return results;
}

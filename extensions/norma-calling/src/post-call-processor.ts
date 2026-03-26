/**
 * Post-call processor — orchestrates outcome analysis, HubSpot logging,
 * DNC list updates, and local call log storage.
 * AI-368: Norma Outbound Voice Calling MVP
 */

import type { CallStore } from "./call-store.js";
import type { HubSpotCallLogger } from "./hubspot-logger.js";
import { analyzeOutcome } from "./outcome-analyzer.js";
import type { PostCallData, CallOutcome, HubSpotLogResult } from "./types.js";

export interface ProcessParams {
  postCallData: PostCallData;
  hubspotContactId: string;
  phone: string;
}

export interface ProcessResult {
  outcome: CallOutcome;
  hubspotResult: HubSpotLogResult;
  skipped?: boolean;
}

export class PostCallProcessor {
  private store: CallStore;
  private hubspotLogger: HubSpotCallLogger;

  constructor(store: CallStore, hubspotLogger: HubSpotCallLogger) {
    this.store = store;
    this.hubspotLogger = hubspotLogger;
  }

  async process(params: ProcessParams): Promise<ProcessResult> {
    const { postCallData, hubspotContactId, phone } = params;
    const { callId } = postCallData;

    // Idempotency check — skip if already processed
    if (this.store.isWebhookProcessed(callId)) {
      return {
        outcome: {
          disposition: "failed",
          summary: "Duplicate webhook",
          interestLevel: 0,
          nextAction: null,
          followUpDate: null,
          qualityScore: 0,
          dnrRequested: false,
        },
        hubspotResult: { callEngagementId: "", noteId: "", status: "complete" },
        skipped: true,
      };
    }

    // Analyze call outcome
    const outcome = analyzeOutcome(postCallData);

    // If DNC requested, add to DNC list
    if (outcome.dnrRequested) {
      this.store.addToDncList(phone, "requested", "call");
    }

    // Log to HubSpot
    const hubspotResult = await this.hubspotLogger.logCall({
      contactId: hubspotContactId,
      transcript: postCallData.transcript,
      outcome,
      durationMs: postCallData.durationSeconds * 1000,
      recordingUrl: null,
    });

    // Log to local SQLite store
    this.store.logCall({
      callId,
      hubspotContactId,
      phone,
      durationSeconds: postCallData.durationSeconds,
      outcome,
      transcript: postCallData.transcript,
      hubspotCallId: hubspotResult.callEngagementId,
      hubspotNoteId: hubspotResult.noteId,
    });

    // Mark as processed only after successful completion
    this.store.markWebhookProcessed(callId);

    return { outcome, hubspotResult };
  }
}

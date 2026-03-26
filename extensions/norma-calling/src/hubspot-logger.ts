/**
 * HubSpot CRM call logging for Norma outbound calls.
 * AI-368: Norma Outbound Voice Calling MVP
 *
 * Logs completed calls as Call engagements + Notes in HubSpot,
 * and updates contact properties with call outcome data.
 */

import type { CallOutcome, CallDisposition, TranscriptEntry, HubSpotLogResult } from "./types.js";

// HubSpot association type IDs (HUBSPOT_DEFINED)
const CALL_TO_CONTACT_ASSOC = 194;
const NOTE_TO_CONTACT_ASSOC = 202;

/**
 * Map Norma disposition to HubSpot call disposition label.
 */
export function mapDispositionToHubSpot(disposition: CallDisposition): string {
  const mapping: Record<CallDisposition, string> = {
    follow_up_booked: "connected",
    materials_requested: "connected",
    interested: "connected",
    transferred: "connected",
    not_interested: "connected",
    dnc_requested: "connected",
    no_answer: "no answer",
    voicemail: "left voicemail",
    busy: "busy",
    failed: "no answer",
    abandoned: "no answer",
  };
  return mapping[disposition] || "no answer";
}

/**
 * Escape HTML entities to prevent XSS in HubSpot notes.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Format transcript as HTML for HubSpot notes.
 */
export function formatTranscriptAsHtml(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) {
    return "<h3>Call Transcript</h3><p><em>No transcript available</em></p>";
  }

  const lines = transcript.map((entry) => {
    const speaker = entry.speaker === "agent" ? "Norma" : "Prospect";
    return `<p><strong>${speaker}:</strong> ${escapeHtml(entry.text)}</p>`;
  });

  return `<h3>Call Transcript</h3>${lines.join("\n")}`;
}

export interface LogCallParams {
  contactId: string;
  transcript: TranscriptEntry[];
  outcome: CallOutcome;
  durationMs: number;
  recordingUrl: string | null;
}

/**
 * HubSpot call logger — creates call engagements, notes, and updates contacts.
 *
 * Accepts any object matching the HubSpot client shape so we can inject
 * mocks for testing without depending on the actual @hubspot/api-client.
 */
export class HubSpotCallLogger {
  private client: any;

  constructor(hubspotClient: any) {
    this.client = hubspotClient;
  }

  async logCall(params: LogCallParams): Promise<HubSpotLogResult> {
    let callEngagementId: string | null = null;
    let noteId: string | null = null;

    try {
      // Step 1: Create call engagement
      const callEngagement = await this.client.crm.objects.calls.basicApi.create({
        properties: {
          hs_call_title: `Norma Outbound: ${params.outcome.disposition}`,
          hs_call_body: params.outcome.summary || "Call completed",
          hs_call_direction: "OUTBOUND",
          hs_call_disposition: mapDispositionToHubSpot(params.outcome.disposition),
          hs_call_duration: String(params.durationMs),
          hs_call_status: "COMPLETED",
          hs_call_recording_url: params.recordingUrl || "",
          hs_timestamp: new Date().toISOString(),
        },
      });
      callEngagementId = callEngagement.id;

      // Step 2: Associate call with contact
      await this.client.crm.objects.calls.associationsApi.create(
        callEngagementId,
        "contacts",
        params.contactId,
        [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: CALL_TO_CONTACT_ASSOC }],
      );

      // Step 3: Create note with transcript
      const note = await this.client.crm.objects.notes.basicApi.create({
        properties: {
          hs_note_body: formatTranscriptAsHtml(params.transcript),
          hs_timestamp: new Date().toISOString(),
        },
      });
      noteId = note.id;

      await this.client.crm.objects.notes.associationsApi.create(
        noteId,
        "contacts",
        params.contactId,
        [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT_ASSOC }],
      );

      // Step 4: Update contact properties
      await this.client.crm.contacts.basicApi.update(params.contactId, {
        properties: {
          norma_last_call_date: new Date().toISOString(),
          norma_call_outcome: params.outcome.disposition,
          norma_interest_level: String(params.outcome.interestLevel || 0),
          norma_next_action: params.outcome.nextAction || "",
        },
      });

      return {
        callEngagementId: callEngagementId!,
        noteId: noteId!,
        status: "complete",
      };
    } catch (error: any) {
      return {
        callEngagementId: callEngagementId || "",
        noteId: noteId || "",
        status: "partial",
        error: error.message || String(error),
      };
    }
  }
}

/**
 * Shared types for Norma outbound calling system.
 * AI-368: Norma Outbound Voice Calling MVP
 */

export type CallDisposition =
  | "follow_up_booked"
  | "materials_requested"
  | "interested"
  | "not_interested"
  | "dnc_requested"
  | "transferred"
  | "voicemail"
  | "no_answer"
  | "busy"
  | "failed"
  | "abandoned";

export interface CallOutcome {
  disposition: CallDisposition;
  summary: string;
  interestLevel: number; // 0-5
  nextAction: string | null;
  followUpDate: Date | null;
  qualityScore: number; // 0-100
  dnrRequested: boolean;
}

export interface TranscriptEntry {
  speaker: "agent" | "user";
  text: string;
  timestamp?: number;
}

export interface PostCallData {
  callId: string;
  transcript: TranscriptEntry[];
  durationSeconds: number;
  analysis?: {
    summary?: string;
    callSuccessful?: boolean;
    dataCollected?: Record<string, string>;
  };
}

export interface ContactContext {
  hubspotContactId: string;
  firstname: string;
  lastname: string;
  company: string;
  phone: string;
  state: string;
  previousCalls: number;
  webEngagement: number;
  recentCalls: Array<{
    date: string;
    outcome: string;
    summary: string;
  }>;
}

export interface HubSpotLogResult {
  callEngagementId: string;
  noteId: string;
  status: "complete" | "partial";
  error?: string;
}

export interface NormaCallingConfig {
  telnyx: {
    apiKey: string;
    connectionId: string;
    publicKey?: string;
    phoneNumber: string;
    appId: string;
  };
  hubspot: {
    accessToken: string;
  };
  elevenlabs?: {
    apiKey: string;
  };
  gateway: {
    webhookUrl: string;
    webhookPort: number;
  };
}

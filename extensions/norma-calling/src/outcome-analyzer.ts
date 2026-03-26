/**
 * Rule-based call outcome analysis from transcript + analysis data.
 * AI-368: Norma Outbound Voice Calling MVP
 *
 * Rules are ordered by priority — DNC detection is highest priority,
 * followed by no-answer/voicemail detection, then disposition analysis.
 * This is intentionally rule-based (not LLM-based) for predictability
 * and auditability.
 */

import type { CallOutcome, PostCallData, CallDisposition } from "./types.js";

const DNC_PHRASES = [
  "take me off",
  "don't call",
  "do not call",
  "stop calling",
  "remove my number",
  "off your list",
];

const BOOKING_PHRASES = [
  "schedule",
  "book",
  "calendar",
  "set up a time",
  "next tuesday",
  "next week",
  "tomorrow",
  "meet",
];

const MATERIAL_PHRASES = [
  "send me",
  "email me",
  "more information",
  "send info",
  "one-pager",
  "brochure",
];

const REJECTION_PHRASES = [
  "not interested",
  "no thanks",
  "no thank you",
  "not for me",
  "pass on this",
];

function textContainsAny(text: string, phrases: string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

export function analyzeOutcome(data: PostCallData): CallOutcome {
  const { transcript, durationSeconds, analysis } = data;

  const prospectText = transcript
    .filter((t) => t.speaker === "user")
    .map((t) => t.text)
    .join(" ");

  const fullText = transcript.map((t) => t.text).join(" ");

  const prospectTurnCount = transcript.filter((t) => t.speaker === "user").length;

  // Rule 1: DNC detection (highest priority)
  if (textContainsAny(prospectText, DNC_PHRASES)) {
    return {
      disposition: "dnc_requested",
      dnrRequested: true,
      interestLevel: 0,
      summary: "DNC requested",
      nextAction: null,
      followUpDate: null,
      qualityScore: calculateQuality(data),
    };
  }

  // Rule 2: No answer (short call, no prospect speech)
  if (durationSeconds < 10 && prospectTurnCount === 0) {
    return {
      disposition: "no_answer",
      dnrRequested: false,
      interestLevel: 0,
      summary: "No answer",
      nextAction: "retry",
      followUpDate: null,
      qualityScore: 0,
    };
  }

  // Rule 3: Voicemail
  if (analysis?.callSuccessful === false && analysis?.dataCollected?.voicemail === "true") {
    return {
      disposition: "voicemail",
      dnrRequested: false,
      interestLevel: 0,
      summary: "Voicemail left",
      nextAction: "retry",
      followUpDate: null,
      qualityScore: 0,
    };
  }

  // Rule 4: Transfer occurred (check agent text for transfer language)
  const agentText = transcript
    .filter((t) => t.speaker === "agent")
    .map((t) => t.text)
    .join(" ");
  if (
    agentText.toLowerCase().includes("connecting you") ||
    analysis?.dataCollected?.transferred === "true"
  ) {
    return {
      disposition: "transferred",
      dnrRequested: false,
      interestLevel: 4,
      summary: analysis?.summary || "Transferred to human",
      nextAction: "follow_up_with_team",
      followUpDate: null,
      qualityScore: calculateQuality(data),
    };
  }

  // Rule 5: Follow-up booked (check prospect text for booking intent)
  if (textContainsAny(prospectText, BOOKING_PHRASES) && analysis?.callSuccessful === true) {
    return {
      disposition: "follow_up_booked",
      dnrRequested: false,
      interestLevel: 5,
      summary: analysis?.summary || "Follow-up booked",
      nextAction: "confirm_meeting",
      followUpDate: null,
      qualityScore: calculateQuality(data),
    };
  }

  // Rule 6: Materials requested
  if (textContainsAny(prospectText, MATERIAL_PHRASES)) {
    return {
      disposition: "materials_requested",
      dnrRequested: false,
      interestLevel: 3,
      summary: analysis?.summary || "Materials requested",
      nextAction: "send_materials",
      followUpDate: null,
      qualityScore: calculateQuality(data),
    };
  }

  // Rule 7: Not interested (explicit rejection)
  if (textContainsAny(prospectText, REJECTION_PHRASES)) {
    return {
      disposition: "not_interested",
      dnrRequested: false,
      interestLevel: 1,
      summary: analysis?.summary || "Not interested",
      nextAction: null,
      followUpDate: null,
      qualityScore: calculateQuality(data),
    };
  }

  // Rule 8: Abandoned (connected but very short, prospect hung up quickly)
  if (durationSeconds < 30 && prospectTurnCount <= 1) {
    return {
      disposition: "abandoned",
      dnrRequested: false,
      interestLevel: 0,
      summary: "Prospect hung up quickly",
      nextAction: "retry",
      followUpDate: null,
      qualityScore: 0,
    };
  }

  // Default: Use analysis data
  const successful = analysis?.callSuccessful === true;
  return {
    disposition: successful ? "interested" : "not_interested",
    dnrRequested: false,
    interestLevel: successful ? 3 : 1,
    summary: analysis?.summary || "Call completed",
    nextAction: successful ? "follow_up" : null,
    followUpDate: null,
    qualityScore: calculateQuality(data),
  };
}

/**
 * Quality scoring: 0-100
 * Evaluates call quality based on AI disclosure, engagement, duration, and outcomes.
 */
export function calculateQuality(data: PostCallData): number {
  let score = 0;
  const { transcript, durationSeconds, analysis } = data;

  // AI disclosure present (mandatory — 20 points)
  const agentText = transcript
    .filter((t) => t.speaker === "agent")
    .map((t) => t.text.toLowerCase())
    .join(" ");
  if (agentText.includes("ai assistant") || agentText.includes("artificial intelligence")) {
    score += 20;
  }

  // Conversation length (up to 20 points, 1 point per 15s)
  score += Math.min(20, Math.floor(durationSeconds / 15));

  // Prospect engagement — talk ratio (up to 20 points)
  const prospectTurns = transcript.filter((t) => t.speaker === "user").length;
  const totalTurns = transcript.length;
  if (totalTurns > 0) {
    const talkRatio = prospectTurns / totalTurns;
    score += Math.min(20, Math.floor(talkRatio * 50));
  }

  // Outcome quality (up to 25 points)
  if (analysis?.callSuccessful) {
    score += 25;
  } else {
    score += 5; // Some credit for any completed call
  }

  // Response brevity (up to 15 points)
  const agentResponses = transcript.filter((t) => t.speaker === "agent");
  if (agentResponses.length > 0) {
    const avgLength =
      agentResponses.reduce((sum, t) => sum + t.text.length, 0) / agentResponses.length;
    if (avgLength < 200) score += 15;
    else if (avgLength < 400) score += 10;
    else score += 5;
  }

  return Math.min(100, score);
}

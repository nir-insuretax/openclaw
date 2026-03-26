/**
 * Norma Outbound Voice Calling MVP
 * AI-368: Norma Outbound Voice Calling — Telnyx Provider
 *
 * Exports all public modules for programmatic use.
 */

export {
  NORMA_SYSTEM_PROMPT,
  buildFirstMessage,
  requiresRecordingConsent,
} from "./norma-persona.js";
export { analyzeOutcome, calculateQuality } from "./outcome-analyzer.js";
export {
  HubSpotCallLogger,
  formatTranscriptAsHtml,
  mapDispositionToHubSpot,
} from "./hubspot-logger.js";
export { CallStore } from "./call-store.js";
export { PostCallProcessor } from "./post-call-processor.js";
export { findUnprocessedCalls, processCompletedCalls } from "./post-call-bridge.js";
export type {
  CallDisposition,
  CallOutcome,
  TranscriptEntry,
  PostCallData,
  ContactContext,
  HubSpotLogResult,
  NormaCallingConfig,
} from "./types.js";

import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema, type VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { CallRecord, NormalizedEvent } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

/**
 * Tests for the driveWebhookConversation() state machine in webhook.ts.
 * This verifies the conversation loop for non-streaming providers (e.g. Telnyx):
 *   TTS finishes (call.active) → startListening
 *   User speaks (call.speech) → stopListening → AI response → speak
 */

const startListening = vi.fn(async () => {});
const stopListening = vi.fn(async () => {});
const playTts = vi.fn(async () => {});

const baseProvider: VoiceCallProvider = {
  name: "mock",
  verifyWebhook: () => ({ ok: true, verifiedRequestKey: "mock:req:conv" }),
  parseWebhookEvent: () => ({ events: [] }),
  initiateCall: async () => ({ providerCallId: "prov-1", status: "initiated" }),
  hangupCall: async () => {},
  playTts,
  startListening,
  stopListening,
  getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
};

const createConfig = (overrides: Partial<VoiceCallConfig> = {}): VoiceCallConfig => {
  const base = VoiceCallConfigSchema.parse({});
  base.serve.port = 0;
  return { ...base, ...overrides, serve: { ...base.serve, ...(overrides.serve ?? {}) } };
};

const conversationCall: CallRecord = {
  callId: "call-conv-1",
  providerCallId: "prov-conv-1",
  provider: "mock",
  direction: "outbound",
  state: "active",
  from: "+15550001234",
  to: "+15550005678",
  startedAt: Date.now(),
  transcript: [],
  processedEventIds: [],
  metadata: { mode: "conversation" },
};

const notifyCall: CallRecord = {
  ...conversationCall,
  callId: "call-notify-1",
  metadata: { mode: "notify" },
};

function createManager(callMap: Record<string, CallRecord>) {
  const processEvent = vi.fn();
  const speak = vi.fn(async () => {});
  const getProvider = vi.fn(() => baseProvider);
  const manager = {
    getActiveCalls: () => Object.values(callMap),
    getCall: (id: string) => callMap[id] ?? null,
    getCallByProviderCallId: (id: string) =>
      Object.values(callMap).find((c) => c.providerCallId === id) ?? null,
    endCall: vi.fn(async () => ({ success: true })),
    processEvent,
    speak,
    getProvider,
    speakInitialMessage: vi.fn(async () => {}),
  } as unknown as CallManager;
  return { manager, processEvent, speak };
}

afterEach(() => {
  vi.restoreAllMocks();
  startListening.mockClear();
  stopListening.mockClear();
  playTts.mockClear();
});

describe("driveWebhookConversation", () => {
  it("starts listening after call.active event (TTS finished) for conversation mode", async () => {
    const { manager, processEvent } = createManager({ "call-conv-1": conversationCall });

    // Provider that produces a call.active event (simulating TTS ended → active)
    const convProvider: VoiceCallProvider = {
      ...baseProvider,
      parseWebhookEvent: () => ({
        events: [
          {
            id: "evt-active-1",
            type: "call.active",
            callId: "call-conv-1",
            providerCallId: "prov-conv-1",
            timestamp: Date.now(),
          } as NormalizedEvent,
        ],
        statusCode: 200,
      }),
    };

    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, convProvider);

    try {
      const baseUrl = await server.start();
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);

      // processEvent should have been called
      expect(processEvent).toHaveBeenCalledTimes(1);

      // Give the async driveWebhookConversation a tick to execute
      await new Promise((r) => setTimeout(r, 50));

      // startListening should be called for conversation-mode call
      expect(startListening).toHaveBeenCalledWith({
        callId: "call-conv-1",
        providerCallId: "prov-conv-1",
      });
    } finally {
      await server.stop();
    }
  });

  it("does NOT start listening for notify-mode calls", async () => {
    const { manager, processEvent } = createManager({ "call-notify-1": notifyCall });

    const convProvider: VoiceCallProvider = {
      ...baseProvider,
      parseWebhookEvent: () => ({
        events: [
          {
            id: "evt-active-2",
            type: "call.active",
            callId: "call-notify-1",
            providerCallId: "prov-conv-1",
            timestamp: Date.now(),
          } as NormalizedEvent,
        ],
        statusCode: 200,
      }),
    };

    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, convProvider);

    try {
      const baseUrl = await server.start();
      await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      await new Promise((r) => setTimeout(r, 50));

      // startListening should NOT be called for notify mode
      expect(startListening).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("does NOT drive conversation when call is not found", async () => {
    // Empty call map — no calls exist
    const { manager } = createManager({});

    const convProvider: VoiceCallProvider = {
      ...baseProvider,
      parseWebhookEvent: () => ({
        events: [
          {
            id: "evt-orphan",
            type: "call.active",
            callId: "call-nonexistent",
            providerCallId: "prov-unknown",
            timestamp: Date.now(),
          } as NormalizedEvent,
        ],
        statusCode: 200,
      }),
    };

    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, convProvider);

    try {
      const baseUrl = await server.start();
      await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      await new Promise((r) => setTimeout(r, 50));

      // Should not try to start listening for unknown call
      expect(startListening).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

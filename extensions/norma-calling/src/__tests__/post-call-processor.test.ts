import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CallStore } from "../call-store.js";
import { PostCallProcessor } from "../post-call-processor.js";
import type { PostCallData } from "../types.js";

let tmpDir: string;
let store: CallStore;

function createMockHubSpotLogger() {
  return {
    logCall: vi.fn().mockResolvedValue({
      callEngagementId: "hs-call-1",
      noteId: "hs-note-1",
      status: "complete",
    }),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "norma-processor-"));
  store = new CallStore(path.join(tmpDir, "norma-calls.sqlite"));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PostCallProcessor", () => {
  it("processes a completed call and logs to store", async () => {
    const mockLogger = createMockHubSpotLogger();
    const processor = new PostCallProcessor(store, mockLogger as any);

    const data: PostCallData = {
      callId: "call-1",
      transcript: [
        { speaker: "agent", text: "Hi, this is Norma, an AI assistant from InsureTax." },
        { speaker: "user", text: "Tell me more about the program." },
        { speaker: "agent", text: "We offer IRS audit insurance backed by Lloyd's." },
        { speaker: "user", text: "Send me more information please." },
      ],
      durationSeconds: 90,
      analysis: { summary: "Prospect wants materials", callSuccessful: true },
    };

    const result = await processor.process({
      postCallData: data,
      hubspotContactId: "contact-1",
      phone: "+15551234567",
    });

    expect(result.outcome.disposition).toBe("materials_requested");
    expect(result.hubspotResult.status).toBe("complete");

    // Verify stored in SQLite
    const log = store.getCallLog("call-1");
    expect(log).toBeTruthy();
    expect(log!.disposition).toBe("materials_requested");
  });

  it("skips duplicate webhooks (idempotency)", async () => {
    const mockLogger = createMockHubSpotLogger();
    const processor = new PostCallProcessor(store, mockLogger as any);

    const data: PostCallData = {
      callId: "call-dup",
      transcript: [{ speaker: "agent", text: "Hello." }],
      durationSeconds: 30,
      analysis: { callSuccessful: false },
    };

    const params = { postCallData: data, hubspotContactId: "c1", phone: "+15551111111" };

    // First call processes
    const first = await processor.process(params);
    expect(first.skipped).toBeFalsy();
    expect(mockLogger.logCall).toHaveBeenCalledOnce();

    // Second call with same callId is skipped
    const second = await processor.process(params);
    expect(second.skipped).toBe(true);
    expect(mockLogger.logCall).toHaveBeenCalledOnce(); // Still only once
  });

  it("adds phone to DNC list when disposition is dnc_requested", async () => {
    const mockLogger = createMockHubSpotLogger();
    const processor = new PostCallProcessor(store, mockLogger as any);

    const data: PostCallData = {
      callId: "call-dnc",
      transcript: [
        { speaker: "agent", text: "Hello." },
        { speaker: "user", text: "Take me off your list." },
      ],
      durationSeconds: 15,
      analysis: { callSuccessful: false },
    };

    await processor.process({
      postCallData: data,
      hubspotContactId: "c-dnc",
      phone: "+15552222222",
    });

    expect(store.isOnDncList("+15552222222")).toBe(true);
  });

  it("allows retry when HubSpot throws (webhook not marked processed)", async () => {
    const mockLogger = createMockHubSpotLogger();
    mockLogger.logCall.mockRejectedValueOnce(new Error("Network error"));

    const processor = new PostCallProcessor(store, mockLogger as any);

    const data: PostCallData = {
      callId: "call-retry",
      transcript: [{ speaker: "agent", text: "Hi." }],
      durationSeconds: 60,
      analysis: { callSuccessful: true, summary: "Good call" },
    };

    const params = { postCallData: data, hubspotContactId: "c-retry", phone: "+15554444444" };

    // First attempt fails
    await expect(processor.process(params)).rejects.toThrow("Network error");

    // Webhook should NOT be marked as processed, so retry works
    expect(store.isWebhookProcessed("call-retry")).toBe(false);

    // Retry succeeds
    mockLogger.logCall.mockResolvedValueOnce({
      callEngagementId: "hs-retry",
      noteId: "hs-note-retry",
      status: "complete",
    });
    const result = await processor.process(params);
    expect(result.skipped).toBeFalsy();
    expect(store.isWebhookProcessed("call-retry")).toBe(true);
  });

  it("handles HubSpot logger errors gracefully", async () => {
    const mockLogger = createMockHubSpotLogger();
    mockLogger.logCall.mockResolvedValue({
      callEngagementId: "hs-1",
      noteId: "",
      status: "partial",
      error: "HubSpot API error",
    });

    const processor = new PostCallProcessor(store, mockLogger as any);

    const data: PostCallData = {
      callId: "call-err",
      transcript: [{ speaker: "agent", text: "Hi." }],
      durationSeconds: 60,
      analysis: { callSuccessful: true, summary: "Good call" },
    };

    const result = await processor.process({
      postCallData: data,
      hubspotContactId: "c-err",
      phone: "+15553333333",
    });

    // Call should still be logged in local store even if HubSpot partially failed
    const log = store.getCallLog("call-err");
    expect(log).toBeTruthy();
    expect(result.hubspotResult.status).toBe("partial");
  });
});

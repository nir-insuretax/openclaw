import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CallStore } from "../call-store.js";
import type { CallOutcome, TranscriptEntry } from "../types.js";

let tmpDir: string;
let store: CallStore;

function makeOutcome(overrides: Partial<CallOutcome> = {}): CallOutcome {
  return {
    disposition: "interested",
    summary: "Test call",
    interestLevel: 3,
    nextAction: "follow_up",
    followUpDate: null,
    qualityScore: 70,
    dnrRequested: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "norma-call-store-"));
  store = new CallStore(path.join(tmpDir, "norma-calls.sqlite"));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("CallStore", () => {
  it("creates tables on initialization", () => {
    // Just verify construction doesn't throw
    expect(store).toBeTruthy();
  });

  it("logs a completed call and retrieves it", () => {
    const transcript: TranscriptEntry[] = [
      { speaker: "agent", text: "Hello." },
      { speaker: "user", text: "Hi." },
    ];

    store.logCall({
      callId: "call-1",
      hubspotContactId: "contact-1",
      phone: "+15551234567",
      durationSeconds: 120,
      outcome: makeOutcome(),
      transcript,
      hubspotCallId: "hs-call-1",
      hubspotNoteId: "hs-note-1",
    });

    const log = store.getCallLog("call-1");
    expect(log).toBeTruthy();
    expect(log!.callId).toBe("call-1");
    expect(log!.phone).toBe("+15551234567");
    expect(log!.disposition).toBe("interested");
    expect(log!.durationSeconds).toBe(120);
    expect(log!.qualityScore).toBe(70);
  });

  it("retrieves recent call logs", () => {
    for (let i = 0; i < 5; i++) {
      store.logCall({
        callId: `call-${i}`,
        hubspotContactId: `contact-${i}`,
        phone: "+15551234567",
        durationSeconds: 60 + i * 30,
        outcome: makeOutcome({ disposition: i < 3 ? "interested" : "not_interested" }),
        transcript: [],
        hubspotCallId: `hs-${i}`,
        hubspotNoteId: `hs-note-${i}`,
      });
    }

    const recent = store.getRecentCalls(3);
    expect(recent).toHaveLength(3);
  });

  it("checks and marks webhook as processed (idempotency)", () => {
    expect(store.isWebhookProcessed("wh-1")).toBe(false);

    store.markWebhookProcessed("wh-1");
    expect(store.isWebhookProcessed("wh-1")).toBe(true);

    // Duplicate should not throw
    store.markWebhookProcessed("wh-1");
    expect(store.isWebhookProcessed("wh-1")).toBe(true);
  });

  it("manages DNC list", () => {
    expect(store.isOnDncList("+15551234567")).toBe(false);

    store.addToDncList("+15551234567", "requested", "call");
    expect(store.isOnDncList("+15551234567")).toBe(true);

    // Adding same number again should not throw
    store.addToDncList("+15551234567", "requested", "call");
    expect(store.isOnDncList("+15551234567")).toBe(true);
  });

  it("stores and retrieves transcript as JSON", () => {
    const transcript: TranscriptEntry[] = [
      { speaker: "agent", text: "Hello, I'm Norma." },
      { speaker: "user", text: "Tell me more." },
    ];

    store.logCall({
      callId: "call-t1",
      hubspotContactId: "contact-t1",
      phone: "+15559876543",
      durationSeconds: 90,
      outcome: makeOutcome(),
      transcript,
      hubspotCallId: "hs-t1",
      hubspotNoteId: "hs-note-t1",
    });

    const log = store.getCallLog("call-t1");
    expect(log).toBeTruthy();
    const parsed = JSON.parse(log!.transcript);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].speaker).toBe("agent");
    expect(parsed[1].text).toBe("Tell me more.");
  });
});

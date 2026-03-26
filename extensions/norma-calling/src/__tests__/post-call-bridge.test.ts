import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CallStore } from "../call-store.js";
import { findUnprocessedCalls } from "../post-call-bridge.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "norma-bridge-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(dir: string, records: unknown[]): void {
  const voiceCallsDir = path.join(dir, "voice-calls");
  fs.mkdirSync(voiceCallsDir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(voiceCallsDir, "calls.jsonl"), lines);
}

function makeCallRecord(overrides: Record<string, unknown> = {}) {
  return {
    callId: "call-abc-123",
    provider: "telnyx",
    direction: "outbound",
    state: "completed",
    from: "+15550001111",
    to: "+15552223333",
    startedAt: 1700000000000,
    answeredAt: 1700000005000,
    endedAt: 1700000065000,
    transcript: [
      { timestamp: 1700000006000, speaker: "bot", text: "Hi, this is Norma." },
      { timestamp: 1700000020000, speaker: "user", text: "Tell me more." },
      { timestamp: 1700000030000, speaker: "bot", text: "We offer audit insurance." },
    ],
    ...overrides,
  };
}

describe("findUnprocessedCalls", () => {
  it("finds completed outbound calls from JSONL", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    writeJsonl(tmpDir, [makeCallRecord()]);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(1);
    expect(result[0].record.callId).toBe("call-abc-123");
    expect(result[0].postCallData.callId).toBe("call-abc-123");
    expect(result[0].postCallData.durationSeconds).toBe(60); // (65000 - 5000) / 1000
    expect(result[0].postCallData.transcript).toHaveLength(3);
    // Verify transcript conversion: bot → agent
    expect(result[0].postCallData.transcript[0].speaker).toBe("agent");
    expect(result[0].postCallData.transcript[1].speaker).toBe("user");
  });

  it("skips inbound calls", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    writeJsonl(tmpDir, [makeCallRecord({ direction: "inbound" })]);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(0);
  });

  it("skips calls in non-terminal state", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    writeJsonl(tmpDir, [makeCallRecord({ state: "active" })]);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(0);
  });

  it("skips already-processed calls", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    writeJsonl(tmpDir, [makeCallRecord()]);

    const dbPath = path.join(tmpDir, "norma.sqlite");

    // Pre-mark the call as processed via the webhook idempotency table
    const store = new CallStore(dbPath);
    store.markWebhookProcessed("call-abc-123");
    store.close();

    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });
    expect(result).toHaveLength(0);
  });

  it("returns empty array when JSONL does not exist", () => {
    const voiceCallsDir = path.join(tmpDir, "nonexistent-voice-calls");
    const dbPath = path.join(tmpDir, "norma.sqlite");

    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });
    expect(result).toHaveLength(0);
  });

  it("handles multiple call records and uses latest per callId", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    // Two entries for same callId — second is the final state
    writeJsonl(tmpDir, [
      makeCallRecord({ state: "active" }),
      makeCallRecord({ state: "completed" }),
    ]);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(1);
    expect(result[0].record.state).toBe("completed");
  });

  it("calculates duration from startedAt when answeredAt is missing", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    writeJsonl(tmpDir, [
      makeCallRecord({
        callId: "call-no-answer-time",
        answeredAt: undefined,
        startedAt: 1700000000000,
        endedAt: 1700000045000,
        state: "completed",
      }),
    ]);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(1);
    expect(result[0].postCallData.durationSeconds).toBe(45);
  });

  it("marks failed calls as not successful in analysis", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    writeJsonl(tmpDir, [makeCallRecord({ state: "failed" })]);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(1);
    expect(result[0].postCallData.analysis?.callSuccessful).toBe(false);
  });

  it("handles all terminal states", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    const terminalStates = [
      "completed",
      "hangup-user",
      "hangup-bot",
      "timeout",
      "error",
      "failed",
      "no-answer",
      "busy",
      "voicemail",
    ];
    const records = terminalStates.map((state, i) =>
      makeCallRecord({ callId: `call-${state}-${i}`, state }),
    );
    writeJsonl(tmpDir, records);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(terminalStates.length);
  });

  it("skips malformed JSONL lines gracefully", () => {
    const voiceCallsDir = path.join(tmpDir, "voice-calls");
    fs.mkdirSync(voiceCallsDir, { recursive: true });
    const content = [
      JSON.stringify(makeCallRecord()),
      "not valid json {{{",
      "",
      JSON.stringify(makeCallRecord({ callId: "call-2", state: "hangup-user" })),
    ].join("\n");
    fs.writeFileSync(path.join(voiceCallsDir, "calls.jsonl"), content);

    const dbPath = path.join(tmpDir, "norma.sqlite");
    const result = findUnprocessedCalls({ voiceCallsDir, dbPath });

    expect(result).toHaveLength(2);
  });
});

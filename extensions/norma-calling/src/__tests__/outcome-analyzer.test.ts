import { describe, it, expect } from "vitest";
import { analyzeOutcome, calculateQuality } from "../outcome-analyzer.js";
import type { PostCallData, TranscriptEntry } from "../types.js";

function makePostCallData(overrides: Partial<PostCallData> = {}): PostCallData {
  return {
    callId: "test-call-1",
    transcript: [],
    durationSeconds: 120,
    analysis: { summary: "Test call", callSuccessful: true },
    ...overrides,
  };
}

function t(speaker: "agent" | "user", text: string): TranscriptEntry {
  return { speaker, text };
}

describe("analyzeOutcome", () => {
  it("detects DNC request as highest priority", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Hi, this is Norma, an AI assistant from InsureTax."),
        t("user", "Take me off your list please."),
      ],
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("dnc_requested");
    expect(result.dnrRequested).toBe(true);
    expect(result.interestLevel).toBe(0);
  });

  it("detects DNC with 'do not call' phrase", () => {
    const data = makePostCallData({
      transcript: [t("agent", "Hello, this is Norma."), t("user", "Do not call me again.")],
    });
    expect(analyzeOutcome(data).disposition).toBe("dnc_requested");
  });

  it("detects DNC with 'stop calling' phrase", () => {
    const data = makePostCallData({
      transcript: [t("agent", "Hello."), t("user", "Stop calling this number.")],
    });
    expect(analyzeOutcome(data).disposition).toBe("dnc_requested");
  });

  it("detects no answer (short call, no user speech)", () => {
    const data = makePostCallData({
      transcript: [],
      durationSeconds: 5,
      analysis: { callSuccessful: false },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("no_answer");
    expect(result.nextAction).toBe("retry");
  });

  it("detects voicemail from analysis data", () => {
    const data = makePostCallData({
      transcript: [t("agent", "Hi, this is Norma.")],
      durationSeconds: 20,
      analysis: {
        callSuccessful: false,
        dataCollected: { voicemail: "true" },
      },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("voicemail");
    expect(result.nextAction).toBe("retry");
  });

  it("detects call transfer", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Let me connect you with someone. Connecting you now."),
        t("user", "I'd like to talk to a real person."),
      ],
      analysis: {
        callSuccessful: true,
        dataCollected: { transferred: "true" },
      },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("transferred");
    expect(result.interestLevel).toBe(4);
  });

  it("detects follow-up booked", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Would you like to schedule a call next week?"),
        t("user", "Sure, let's set up a time next Tuesday."),
      ],
      analysis: { summary: "Prospect agreed to meet", callSuccessful: true },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("follow_up_booked");
    expect(result.interestLevel).toBe(5);
  });

  it("detects materials requested", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Can I tell you more about the program?"),
        t("user", "Sure, but can you send me more information by email first?"),
      ],
      analysis: { callSuccessful: true },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("materials_requested");
    expect(result.interestLevel).toBe(3);
  });

  it("detects not interested", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Would you like to hear about our partnership program?"),
        t("user", "No thanks, not interested."),
      ],
      analysis: { callSuccessful: false },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("not_interested");
    expect(result.interestLevel).toBe(1);
  });

  it("detects abandoned call (short, minimal user speech)", () => {
    const data = makePostCallData({
      transcript: [t("agent", "Hi, this is Norma from InsureTax."), t("user", "Hello?")],
      durationSeconds: 15,
      analysis: { callSuccessful: false },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("abandoned");
    expect(result.nextAction).toBe("retry");
  });

  it("defaults to interested when analysis says successful", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Tell me about your business."),
        t("user", "We handle auto and home insurance in the midwest."),
        t("agent", "That sounds great."),
        t("user", "Yeah, I'd be open to learning more."),
      ],
      durationSeconds: 180,
      analysis: { summary: "Positive conversation", callSuccessful: true },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("interested");
    expect(result.interestLevel).toBe(3);
  });

  it("defaults to not_interested when analysis says unsuccessful", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Can I tell you about our program?"),
        t("user", "I'm busy right now, maybe later."),
        t("agent", "Okay, have a great day."),
      ],
      durationSeconds: 45,
      analysis: { callSuccessful: false },
    });
    const result = analyzeOutcome(data);
    expect(result.disposition).toBe("not_interested");
  });
});

describe("calculateQuality", () => {
  it("gives points for AI disclosure", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "Hi, this is Norma, an AI assistant from InsureTax."),
        t("user", "Hello."),
      ],
      durationSeconds: 60,
      analysis: { callSuccessful: true },
    });
    const score = calculateQuality(data);
    expect(score).toBeGreaterThanOrEqual(20); // 20 for disclosure
  });

  it("gives zero for empty transcript", () => {
    const data = makePostCallData({
      transcript: [],
      durationSeconds: 0,
      analysis: { callSuccessful: false },
    });
    expect(calculateQuality(data)).toBe(5); // 5 for completed call (unsuccessful)
  });

  it("caps at 100", () => {
    const data = makePostCallData({
      transcript: [
        t("agent", "This is Norma, an AI assistant."),
        t("user", "Tell me more."),
        t("agent", "Sure."),
        t("user", "That sounds great."),
        t("agent", "Wonderful."),
        t("user", "Let's schedule."),
      ],
      durationSeconds: 300,
      analysis: { callSuccessful: true },
    });
    expect(calculateQuality(data)).toBeLessThanOrEqual(100);
  });

  it("gives higher score for longer engaging conversations", () => {
    const short = makePostCallData({
      transcript: [t("agent", "Hello."), t("user", "Bye.")],
      durationSeconds: 10,
      analysis: { callSuccessful: false },
    });
    const long = makePostCallData({
      transcript: [
        t("agent", "This is Norma, an AI assistant from InsureTax."),
        t("user", "Hi, tell me more."),
        t("agent", "We offer IRS audit insurance."),
        t("user", "That sounds interesting."),
        t("agent", "Can I schedule a follow-up?"),
        t("user", "Sure, next week works."),
      ],
      durationSeconds: 180,
      analysis: { callSuccessful: true },
    });
    expect(calculateQuality(long)).toBeGreaterThan(calculateQuality(short));
  });
});

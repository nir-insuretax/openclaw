import { describe, it, expect } from "vitest";
import {
  buildFirstMessage,
  requiresRecordingConsent,
  NORMA_SYSTEM_PROMPT,
} from "../norma-persona.js";

describe("NORMA_SYSTEM_PROMPT", () => {
  it("includes AI disclosure requirement", () => {
    expect(NORMA_SYSTEM_PROMPT).toContain("AI assistant");
    expect(NORMA_SYSTEM_PROMPT).toContain("Mandatory Disclosure");
  });

  it("includes DNC handling", () => {
    expect(NORMA_SYSTEM_PROMPT).toContain("take me off your list");
    expect(NORMA_SYSTEM_PROMPT).toContain("do not call");
  });

  it("includes call duration limit", () => {
    expect(NORMA_SYSTEM_PROMPT).toContain("7 minutes");
  });

  it("prohibits denying AI identity", () => {
    expect(NORMA_SYSTEM_PROMPT).toContain("NEVER deny being an AI");
  });
});

describe("buildFirstMessage", () => {
  it("uses contact name when provided", () => {
    const msg = buildFirstMessage({ firstname: "John" });
    expect(msg).toContain("Hi John");
  });

  it("falls back to 'there' when no name", () => {
    const msg = buildFirstMessage({});
    expect(msg).toContain("Hi there");
  });

  it("includes AI disclosure", () => {
    const msg = buildFirstMessage({ firstname: "Jane" });
    expect(msg).toContain("AI assistant calling from InsureTax");
  });

  it("includes recording consent for two-party states", () => {
    const msg = buildFirstMessage({
      firstname: "Jane",
      requiresRecordingConsent: true,
    });
    expect(msg).toContain("This call is being recorded");
    expect(msg).toContain("consent");
  });

  it("omits recording consent when not required", () => {
    const msg = buildFirstMessage({ firstname: "Jane" });
    expect(msg).not.toContain("recorded");
  });

  it("uses follow-up messaging for returning contacts", () => {
    const msg = buildFirstMessage({ firstname: "Bob", previousCalls: 2 });
    expect(msg).toContain("following up");
  });

  it("uses web engagement messaging for web-engaged contacts", () => {
    const msg = buildFirstMessage({ firstname: "Alice", webEngagement: 3 });
    expect(msg).toContain("looking at our broker partner program");
  });

  it("uses cold call messaging by default", () => {
    const msg = buildFirstMessage({
      firstname: "Carol",
      company: "Acme Insurance",
      state: "TX",
    });
    expect(msg).toContain("expanding our broker partner network in TX");
    expect(msg).toContain("Acme Insurance");
  });

  it("handles cold call without company or state", () => {
    const msg = buildFirstMessage({ firstname: "Dave" });
    expect(msg).toContain("expanding our broker partner network");
    expect(msg).not.toContain("undefined");
  });
});

describe("requiresRecordingConsent", () => {
  it("returns true for California", () => {
    expect(requiresRecordingConsent("CA")).toBe(true);
  });

  it("returns true for Florida", () => {
    expect(requiresRecordingConsent("FL")).toBe(true);
  });

  it("returns true for Illinois", () => {
    expect(requiresRecordingConsent("IL")).toBe(true);
  });

  it("returns false for Texas (one-party state)", () => {
    expect(requiresRecordingConsent("TX")).toBe(false);
  });

  it("returns false for New York (one-party state)", () => {
    expect(requiresRecordingConsent("NY")).toBe(false);
  });

  it("handles lowercase input", () => {
    expect(requiresRecordingConsent("ca")).toBe(true);
    expect(requiresRecordingConsent("tx")).toBe(false);
  });
});

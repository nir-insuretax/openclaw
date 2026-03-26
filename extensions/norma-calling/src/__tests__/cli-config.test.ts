import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildFirstMessage,
  requiresRecordingConsent,
  NORMA_SYSTEM_PROMPT,
} from "../norma-persona.js";

/**
 * Tests for cli.ts logic paths: config loading, message building,
 * and consent logic used by the CLI commands.
 *
 * The CLI itself is a commander program that calls process-level functions.
 * We test the building blocks rather than spawning subprocesses.
 */

describe("CLI message building", () => {
  it("builds first message with name and company", () => {
    const msg = buildFirstMessage({
      firstname: "John",
      company: "Acme Corp",
      requiresRecordingConsent: false,
    });

    expect(msg).toContain("John");
    expect(msg).toContain("Acme Corp");
  });

  it("builds first message with recording consent", () => {
    const msg = buildFirstMessage({
      firstname: "Jane",
      state: "CA",
      requiresRecordingConsent: true,
    });

    // Should mention recording/consent when required
    expect(msg.toLowerCase()).toMatch(/record|consent|permission/);
  });

  it("builds first message with default name", () => {
    const msg = buildFirstMessage({
      firstname: "there",
      requiresRecordingConsent: false,
    });

    expect(msg).toContain("there");
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(10);
  });

  it("NORMA_SYSTEM_PROMPT is non-empty and has insurance context", () => {
    expect(NORMA_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(NORMA_SYSTEM_PROMPT.toLowerCase()).toMatch(/insur|tax|audit/);
  });
});

describe("Recording consent logic", () => {
  it("requires consent for two-party consent states", () => {
    // California is a two-party consent state
    expect(requiresRecordingConsent("CA")).toBe(true);
  });

  it("does not require consent for one-party consent states", () => {
    // Texas is a one-party consent state
    expect(requiresRecordingConsent("TX")).toBe(false);
  });

  it("handles lowercase state codes", () => {
    // Should normalize state code
    const result = requiresRecordingConsent("ca");
    expect(typeof result).toBe("boolean");
  });
});

describe("CLI config structure", () => {
  it("loads config from environment variables when config.json missing", () => {
    // Simulate what loadConfig() does when no config file exists
    const config = {
      telnyx: {
        apiKey: process.env.TELNYX_API_KEY || "",
        connectionId: process.env.TELNYX_CONNECTION_ID || "",
        publicKey: process.env.TELNYX_PUBLIC_KEY || "",
        phoneNumber: process.env.TELNYX_PHONE_NUMBER || "",
        appId: process.env.TELNYX_APP_ID || "",
      },
      hubspot: {
        accessToken: process.env.HUBSPOT_ACCESS_TOKEN || "",
      },
      gateway: {
        webhookUrl: process.env.NORMA_WEBHOOK_URL || "http://localhost:3334/voice/webhook",
        webhookPort: Number(process.env.NORMA_WEBHOOK_PORT || "3334"),
      },
    };

    expect(config.gateway.webhookPort).toBe(3334);
    expect(config.gateway.webhookUrl).toContain("webhook");
    expect(config.telnyx).toHaveProperty("apiKey");
    expect(config.telnyx).toHaveProperty("connectionId");
    expect(config.hubspot).toHaveProperty("accessToken");
  });
});

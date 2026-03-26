#!/usr/bin/env node
/**
 * Norma Outbound Calling CLI — test interface for MVP.
 * AI-368: Norma Outbound Voice Calling MVP
 *
 * Usage:
 *   npx ts-node src/cli.ts call --to +15551234567
 *   npx ts-node src/cli.ts status
 *   npx ts-node src/cli.ts history
 *   npx ts-node src/cli.ts process-webhook <json-file>
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { WebSocket } from "ws";
import { CallStore } from "./call-store.js";
import { HubSpotCallLogger } from "./hubspot-logger.js";
import {
  buildFirstMessage,
  requiresRecordingConsent,
  NORMA_SYSTEM_PROMPT,
} from "./norma-persona.js";
import { analyzeOutcome } from "./outcome-analyzer.js";
import { findUnprocessedCalls, processCompletedCalls } from "./post-call-bridge.js";
import { PostCallProcessor } from "./post-call-processor.js";
import type { PostCallData, NormaCallingConfig } from "./types.js";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".openclaw", "norma-calls", "norma-calls.sqlite");

function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig(): NormaCallingConfig {
  const configPath = path.join(os.homedir(), ".openclaw", "norma-calls", "config.json");
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  // Fall back to environment variables
  return {
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
}

/**
 * Send a single RPC request to the OpenClaw gateway via WebSocket.
 * Handles the connect handshake, then sends the method call and returns the response.
 */
async function gatewayRpc(
  wsUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const reqId = `norma-${Date.now()}`;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`Gateway RPC timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    ws.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle connect challenge → send connect request
        if (msg.type === "event" && msg.event === "connect.challenge") {
          ws.send(
            JSON.stringify({
              type: "req",
              id: "connect-1",
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: { id: "cli", version: "2026.3.23", platform: "linux", mode: "cli" },
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.admin"],
                auth: { token },
              },
            }),
          );
          return;
        }

        // Handle connect response → send the actual RPC method
        if (msg.type === "res" && msg.id === "connect-1") {
          if (!msg.ok) {
            settled = true;
            clearTimeout(timer);
            ws.close();
            reject(new Error(`Gateway connect failed: ${JSON.stringify(msg)}`));
            return;
          }
          ws.send(
            JSON.stringify({
              type: "req",
              id: reqId,
              method,
              params,
            }),
          );
          return;
        }

        // Handle method response
        if (msg.type === "res" && msg.id === reqId) {
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
          return;
        }
      } catch {
        // Ignore parse errors on non-JSON frames
      }
    });
  });
}

const program = new Command();

program
  .name("norma-calling")
  .description("Norma Outbound Voice Calling CLI (AI-368 MVP)")
  .version("0.1.0");

program
  .command("call")
  .description("Initiate an outbound test call via OpenClaw voice-call extension")
  .requiredOption("--to <phone>", "Phone number to call (E.164 format)")
  .option("--name <name>", "Contact first name", "there")
  .option("--company <company>", "Contact company name")
  .option("--state <state>", "Contact state (two-letter code)")
  .action(async (options: { to: string; name: string; company?: string; state?: string }) => {
    const config = loadConfig();

    const consent = options.state ? requiresRecordingConsent(options.state) : false;
    const firstMessage = buildFirstMessage({
      firstname: options.name,
      company: options.company,
      state: options.state,
      requiresRecordingConsent: consent,
    });

    // Build OpenClaw voicecall CLI command
    const cmd = [
      "openclaw",
      "voicecall",
      "call",
      "--to",
      options.to,
      "--message",
      firstMessage,
      "--mode",
      "conversation",
    ];

    console.log("--- Norma Outbound Call ---");
    console.log(`To: ${options.to}`);
    console.log(`First message: ${firstMessage}`);
    console.log(`Recording consent required: ${consent}`);
    console.log(`System prompt length: ${NORMA_SYSTEM_PROMPT.length} chars`);
    console.log("");
    console.log("Gateway command:");
    console.log(`  ${cmd.join(" ")}`);
    console.log("");
    console.log("To execute, run the above command or configure the gateway with:");
    console.log("  provider: telnyx");
    console.log(`  fromNumber: ${config.telnyx.phoneNumber}`);
    console.log("  outbound.defaultMode: conversation");
    console.log("  responseSystemPrompt: <Norma system prompt>");
  });

program
  .command("process-webhook")
  .description("Process a post-call webhook payload (JSON file or stdin)")
  .option("--file <path>", "Path to JSON file with post-call data")
  .option("--contact-id <id>", "HubSpot contact ID")
  .option("--phone <phone>", "Phone number called")
  .option("--db <path>", "SQLite database path", DEFAULT_DB_PATH)
  .action(async (options: { file?: string; contactId?: string; phone?: string; db: string }) => {
    let rawData: string;
    if (options.file) {
      rawData = fs.readFileSync(options.file, "utf-8");
    } else {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      rawData = Buffer.concat(chunks).toString("utf-8");
    }

    const parsed = JSON.parse(rawData);
    if (
      !parsed.callId ||
      !Array.isArray(parsed.transcript) ||
      typeof parsed.durationSeconds !== "number"
    ) {
      console.error(
        "Invalid post-call data: must have callId (string), transcript (array), durationSeconds (number)",
      );
      process.exit(1);
    }
    const postCallData: PostCallData = parsed;
    const contactId = options.contactId || "unknown";
    const phone = options.phone || "unknown";

    // Analyze outcome (dry run — no HubSpot)
    const outcome = analyzeOutcome(postCallData);

    console.log("--- Post-Call Analysis ---");
    console.log(`Call ID: ${postCallData.callId}`);
    console.log(`Duration: ${postCallData.durationSeconds}s`);
    console.log(`Disposition: ${outcome.disposition}`);
    console.log(`Interest Level: ${outcome.interestLevel}/5`);
    console.log(`Quality Score: ${outcome.qualityScore}/100`);
    console.log(`DNC Requested: ${outcome.dnrRequested}`);
    console.log(`Next Action: ${outcome.nextAction || "none"}`);
    console.log(`Summary: ${outcome.summary}`);

    // Log to local store
    ensureDbDir(options.db);
    const store = new CallStore(options.db);
    store.logCall({
      callId: postCallData.callId,
      hubspotContactId: contactId,
      phone,
      durationSeconds: postCallData.durationSeconds,
      outcome,
      transcript: postCallData.transcript,
      hubspotCallId: "",
      hubspotNoteId: "",
    });
    store.close();

    console.log(`\nLogged to: ${options.db}`);
  });

program
  .command("history")
  .description("Show recent call history")
  .option("--limit <n>", "Number of recent calls to show", "10")
  .option("--db <path>", "SQLite database path", DEFAULT_DB_PATH)
  .action((options: { limit: string; db: string }) => {
    if (!fs.existsSync(options.db)) {
      console.log("No call history found. Database does not exist yet.");
      return;
    }

    const store = new CallStore(options.db);
    const calls = store.getRecentCalls(Number(options.limit));
    store.close();

    if (calls.length === 0) {
      console.log("No calls logged yet.");
      return;
    }

    console.log(`--- Last ${calls.length} Calls ---`);
    for (const call of calls) {
      console.log(
        `${call.createdAt} | ${call.disposition.padEnd(20)} | ${call.durationSeconds}s | Q:${call.qualityScore} | ${call.phone}`,
      );
    }
  });

program
  .command("show-persona")
  .description("Display Norma's system prompt for voice calls")
  .action(() => {
    console.log(NORMA_SYSTEM_PROMPT);
  });

program
  .command("live-call")
  .description("Initiate a live conversational call via the gateway voice-call plugin")
  .requiredOption("--to <phone>", "Phone number to call (E.164 format)")
  .option("--name <name>", "Contact first name", "there")
  .option("--company <company>", "Contact company name")
  .option("--state <state>", "Contact state (two-letter code)")
  .option("--gateway-url <url>", "Gateway base URL", "http://127.0.0.1:18789")
  .option("--gateway-token <token>", "Gateway auth token")
  .action(
    async (options: {
      to: string;
      name: string;
      company?: string;
      state?: string;
      gatewayUrl: string;
      gatewayToken?: string;
    }) => {
      const config = loadConfig();
      const consent = options.state ? requiresRecordingConsent(options.state) : false;
      const firstMessage = buildFirstMessage({
        firstname: options.name,
        company: options.company,
        state: options.state,
        requiresRecordingConsent: consent,
      });

      const gatewayToken =
        options.gatewayToken ||
        process.env.OPENCLAW_GATEWAY_TOKEN ||
        "7c9cd88b21c9ae2fcc3107807f02cccbe9b10a10d69e7bc6";

      console.log("--- Norma Live Conversational Call ---");
      console.log(`To: ${options.to}`);
      console.log(`First message: ${firstMessage.slice(0, 80)}...`);
      console.log(`Recording consent: ${consent}`);
      console.log("");

      try {
        const resp = await fetch(`${options.gatewayUrl}/tools/invoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${gatewayToken}`,
          },
          body: JSON.stringify({
            tool: "voice_call",
            action: "initiate_call",
            args: {
              to: options.to,
              message: firstMessage,
              mode: "conversation",
            },
          }),
        });

        const result = (await resp.json()) as any;

        if (result.ok && result.result?.details?.callId) {
          const callId = result.result.details.callId;
          console.log(`Call initiated! Call ID: ${callId}`);
          console.log("");
          console.log("The conversation is now handled automatically by the voice-call plugin.");
          console.log("Norma will respond using her system prompt via Claude Sonnet 4.");
          console.log("");
          console.log("To check status:");
          console.log(`  node dist/cli.js call-status --call-id ${callId}`);
          console.log("");
          console.log("After the call ends, run:");
          console.log("  node dist/cli.js process-calls");
        } else {
          console.error("Failed to initiate call:", JSON.stringify(result, null, 2));
        }
      } catch (err) {
        console.error("Gateway request failed:", err);
        console.log("");
        console.log("Make sure the gateway is running and voice-call plugin is configured.");
        console.log("Gateway needs to be restarted to pick up new plugin config.");
      }
    },
  );

program
  .command("call-status")
  .description("Check the status of an active or completed call")
  .requiredOption("--call-id <id>", "Call ID to check")
  .option("--gateway-url <url>", "Gateway base URL", "http://127.0.0.1:18789")
  .option("--gateway-token <token>", "Gateway auth token")
  .action(async (options: { callId: string; gatewayUrl: string; gatewayToken?: string }) => {
    const gatewayToken =
      options.gatewayToken ||
      process.env.OPENCLAW_GATEWAY_TOKEN ||
      "7c9cd88b21c9ae2fcc3107807f02cccbe9b10a10d69e7bc6";

    try {
      const resp = await fetch(`${options.gatewayUrl}/tools/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          tool: "voice_call",
          args: { mode: "status", sid: options.callId },
        }),
      });

      const result = (await resp.json()) as any;
      const call = result.result?.details?.call;

      if (call) {
        console.log(`--- Call ${call.callId} ---`);
        console.log(`  State: ${call.state}`);
        console.log(`  Direction: ${call.direction}`);
        console.log(`  From: ${call.from} → To: ${call.to}`);
        console.log(`  Started: ${new Date(call.startedAt).toISOString()}`);
        if (call.answeredAt) console.log(`  Answered: ${new Date(call.answeredAt).toISOString()}`);
        if (call.endedAt) console.log(`  Ended: ${new Date(call.endedAt).toISOString()}`);
        if (call.endReason) console.log(`  End Reason: ${call.endReason}`);
        console.log(`  Transcript turns: ${call.transcript?.length ?? 0}`);
        if (call.transcript?.length > 0) {
          console.log("\n  --- Transcript ---");
          for (const t of call.transcript) {
            const speaker = t.speaker === "bot" ? "Norma" : "Prospect";
            console.log(`  [${speaker}]: ${t.text}`);
          }
        }
      } else {
        console.log("Call not found or no longer active.");
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error("Failed to check status:", err);
    }
  });

program
  .command("process-calls")
  .description("Process completed calls: analyze outcomes, log to HubSpot, store transcripts")
  .option("--db <path>", "SQLite database path", DEFAULT_DB_PATH)
  .option("--dry-run", "Analyze without logging to HubSpot")
  .action(async (options: { db: string; dryRun?: boolean }) => {
    const config = loadConfig();

    const unprocessed = findUnprocessedCalls({ dbPath: options.db });
    if (unprocessed.length === 0) {
      console.log("No unprocessed calls found.");
      return;
    }

    console.log(`Found ${unprocessed.length} unprocessed call(s)`);

    if (options.dryRun) {
      for (const { record, postCallData } of unprocessed) {
        const outcome = analyzeOutcome(postCallData);
        console.log(`\n--- Call ${record.callId} ---`);
        console.log(`  To: ${record.to}`);
        console.log(`  Duration: ${postCallData.durationSeconds}s`);
        console.log(`  Transcript turns: ${postCallData.transcript.length}`);
        console.log(`  Disposition: ${outcome.disposition}`);
        console.log(`  Interest: ${outcome.interestLevel}/5`);
        console.log(`  Quality: ${outcome.qualityScore}/100`);
      }
      return;
    }

    if (!config.hubspot.accessToken) {
      console.error(
        "HubSpot access token not configured. Set in config.json or HUBSPOT_ACCESS_TOKEN env.",
      );
      process.exit(1);
    }

    // Dynamic import of HubSpot client
    const { Client } = await import("@hubspot/api-client");
    const hubspotClient = new Client({ accessToken: config.hubspot.accessToken });

    const results = await processCompletedCalls({
      hubspotClient,
      dbPath: options.db,
    });

    console.log(`\n--- Processing Complete ---`);
    for (const r of results) {
      console.log(
        `  ${r.callId.slice(0, 8)}... | ${r.phone} | ${r.disposition} | HubSpot: ${r.hubspotStatus}`,
      );
    }
  });

program
  .command("show-config")
  .description("Show the gateway configuration needed for Norma calling")
  .action(() => {
    const config = loadConfig();
    console.log("--- Gateway Voice-Call Configuration ---");
    console.log(
      JSON.stringify(
        {
          "voice-call": {
            enabled: true,
            provider: "telnyx",
            telnyx: {
              apiKey: config.telnyx.apiKey ? "***" : "(not set — use TELNYX_API_KEY env)",
              connectionId:
                config.telnyx.connectionId || "(not set — use TELNYX_CONNECTION_ID env)",
              publicKey: config.telnyx.publicKey ? "***" : "(optional — use TELNYX_PUBLIC_KEY env)",
            },
            fromNumber: config.telnyx.phoneNumber,
            outbound: {
              defaultMode: "conversation",
            },
            maxDurationSeconds: 420,
            responseModel: "anthropic/claude-sonnet-4",
            responseSystemPrompt: "<norma-persona.ts NORMA_SYSTEM_PROMPT>",
            serve: {
              port: config.gateway.webhookPort,
              bind: "127.0.0.1",
              path: "/voice/webhook",
            },
          },
        },
        null,
        2,
      ),
    );
  });

program.parse();

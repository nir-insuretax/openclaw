# Norma Outbound Voice Calling MVP

**JIRA:** AI-368
**Provider:** Telnyx (via OpenClaw voice-call extension)

## Overview

Norma's outbound voice calling system for partner outreach. Uses the OpenClaw voice-call extension with Telnyx as the telephony provider, and adds:

- **Norma voice persona** — system prompt for professional, compliance-aware phone conversations
- **Outcome analysis** — rule-based call disposition from transcripts (DNC, booking, materials, etc.)
- **HubSpot CRM logging** — call engagements, notes with transcripts, contact property updates
- **SQLite call store** — persistent call log with DNC list and webhook idempotency
- **CLI** — test calls, webhook processing, call history

## Setup

### 1. Gateway Configuration

Add to `~/.openclaw/openclaw.json` under `plugins.entries`:

```json
"voice-call": {
  "enabled": true,
  "config": {
    "provider": "telnyx",
    "fromNumber": "+19177799737",
    "outbound": {
      "defaultMode": "conversation"
    },
    "maxDurationSeconds": 420,
    "responseModel": "anthropic/claude-sonnet-4",
    "responseSystemPrompt": "<paste NORMA_SYSTEM_PROMPT from src/norma-persona.ts>",
    "serve": {
      "port": 3334,
      "bind": "127.0.0.1",
      "path": "/voice/webhook"
    },
    "staleCallReaperSeconds": 300,
    "maxConcurrentCalls": 1,
    "skipSignatureVerification": false
  }
}
```

Add `"voice-call"` to `plugins.allow` array.

### 2. Environment Variables

Set via AWS Secrets Manager or directly:

```bash
export TELNYX_API_KEY="KEY019D..."
export TELNYX_CONNECTION_ID="2923588101919999075"
export HUBSPOT_ACCESS_TOKEN="..."
```

### 3. Webhook Tunnel

For development, use ngrok or Tailscale funnel:

```bash
openclaw voicecall expose --mode funnel
```

### 4. Test Call

```bash
# Via OpenClaw CLI
openclaw voicecall call --to +15551234567 --message "Hi, this is Norma..." --mode conversation

# Via Norma CLI (generates first message from contact data)
npx ts-node src/cli.ts call --to +15551234567 --name "John" --company "Acme Insurance" --state "NY"
```

### 5. Process Completed Calls

```bash
npx ts-node src/cli.ts process-webhook --file /path/to/post-call.json --contact-id HS123 --phone +15551234567
```

## Architecture

```
Telnyx PSTN ──webhook──▶ OpenClaw Voice-Call Extension
                              │
                              ├── Call state management
                              ├── TTS (speak) / STT (listen)
                              ├── Transcript capture (JSONL)
                              │
                              ▼ (call ends)
                         Norma Calling Module
                              │
                              ├── Outcome analysis (rule-based)
                              ├── HubSpot CRM logging
                              ├── SQLite call store
                              └── DNC list management
```

## Tests

```bash
npm test        # 57 tests
npm run lint    # TypeScript type check
```

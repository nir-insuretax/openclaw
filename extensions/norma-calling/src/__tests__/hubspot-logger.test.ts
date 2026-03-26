import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HubSpotCallLogger,
  formatTranscriptAsHtml,
  mapDispositionToHubSpot,
} from "../hubspot-logger.js";
import type { CallOutcome, TranscriptEntry } from "../types.js";

// Mock HubSpot client
function createMockHubSpotClient() {
  return {
    crm: {
      objects: {
        calls: {
          basicApi: {
            create: vi.fn().mockResolvedValue({ id: "call-123" }),
          },
          associationsApi: {
            create: vi.fn().mockResolvedValue({}),
          },
        },
        notes: {
          basicApi: {
            create: vi.fn().mockResolvedValue({ id: "note-456" }),
          },
          associationsApi: {
            create: vi.fn().mockResolvedValue({}),
          },
        },
      },
      contacts: {
        basicApi: {
          update: vi.fn().mockResolvedValue({}),
        },
      },
    },
  };
}

describe("formatTranscriptAsHtml", () => {
  it("formats empty transcript", () => {
    expect(formatTranscriptAsHtml([])).toBe(
      "<h3>Call Transcript</h3><p><em>No transcript available</em></p>",
    );
  });

  it("formats transcript entries with speaker labels", () => {
    const transcript: TranscriptEntry[] = [
      { speaker: "agent", text: "Hello, this is Norma." },
      { speaker: "user", text: "Hi there." },
    ];
    const html = formatTranscriptAsHtml(transcript);
    expect(html).toContain("<strong>Norma:</strong>");
    expect(html).toContain("<strong>Prospect:</strong>");
    expect(html).toContain("Hello, this is Norma.");
    expect(html).toContain("Hi there.");
  });

  it("escapes HTML entities in transcript text", () => {
    const transcript: TranscriptEntry[] = [
      { speaker: "user", text: 'Test <script>alert("xss")</script>' },
    ];
    const html = formatTranscriptAsHtml(transcript);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("mapDispositionToHubSpot", () => {
  it("maps follow_up_booked to connected", () => {
    expect(mapDispositionToHubSpot("follow_up_booked")).toBe("connected");
  });

  it("maps no_answer to no answer", () => {
    expect(mapDispositionToHubSpot("no_answer")).toBe("no answer");
  });

  it("maps voicemail to left voicemail", () => {
    expect(mapDispositionToHubSpot("voicemail")).toBe("left voicemail");
  });

  it("maps busy to busy", () => {
    expect(mapDispositionToHubSpot("busy")).toBe("busy");
  });

  it("maps dnc_requested to connected", () => {
    expect(mapDispositionToHubSpot("dnc_requested")).toBe("connected");
  });
});

describe("HubSpotCallLogger", () => {
  let mockClient: ReturnType<typeof createMockHubSpotClient>;
  let logger: HubSpotCallLogger;

  beforeEach(() => {
    mockClient = createMockHubSpotClient();
    logger = new HubSpotCallLogger(mockClient as any);
  });

  it("creates call engagement with correct properties", async () => {
    const outcome: CallOutcome = {
      disposition: "interested",
      summary: "Good conversation",
      interestLevel: 3,
      nextAction: "follow_up",
      followUpDate: null,
      qualityScore: 75,
      dnrRequested: false,
    };

    const result = await logger.logCall({
      contactId: "contact-1",
      transcript: [
        { speaker: "agent", text: "Hello." },
        { speaker: "user", text: "Hi." },
      ],
      outcome,
      durationMs: 120000,
      recordingUrl: null,
    });

    expect(result.callEngagementId).toBe("call-123");
    expect(result.noteId).toBe("note-456");
    expect(result.status).toBe("complete");

    // Verify call engagement was created
    const callCreate = mockClient.crm.objects.calls.basicApi.create;
    expect(callCreate).toHaveBeenCalledOnce();
    const callProps = callCreate.mock.calls[0][0].properties;
    expect(callProps.hs_call_title).toContain("Norma Outbound");
    expect(callProps.hs_call_direction).toBe("OUTBOUND");
    expect(callProps.hs_call_status).toBe("COMPLETED");
    expect(callProps.hs_call_duration).toBe("120000");
  });

  it("associates call and note with contact", async () => {
    const outcome: CallOutcome = {
      disposition: "not_interested",
      summary: "Declined",
      interestLevel: 1,
      nextAction: null,
      followUpDate: null,
      qualityScore: 30,
      dnrRequested: false,
    };

    await logger.logCall({
      contactId: "contact-2",
      transcript: [],
      outcome,
      durationMs: 30000,
      recordingUrl: null,
    });

    // Call association
    expect(mockClient.crm.objects.calls.associationsApi.create).toHaveBeenCalledWith(
      "call-123",
      "contacts",
      "contact-2",
      expect.any(Array),
    );

    // Note association
    expect(mockClient.crm.objects.notes.associationsApi.create).toHaveBeenCalledWith(
      "note-456",
      "contacts",
      "contact-2",
      expect.any(Array),
    );
  });

  it("updates contact properties with call outcome", async () => {
    const outcome: CallOutcome = {
      disposition: "follow_up_booked",
      summary: "Meeting scheduled",
      interestLevel: 5,
      nextAction: "confirm_meeting",
      followUpDate: null,
      qualityScore: 90,
      dnrRequested: false,
    };

    await logger.logCall({
      contactId: "contact-3",
      transcript: [],
      outcome,
      durationMs: 180000,
      recordingUrl: null,
    });

    const updateCall = mockClient.crm.contacts.basicApi.update;
    expect(updateCall).toHaveBeenCalledWith("contact-3", {
      properties: expect.objectContaining({
        norma_call_outcome: "follow_up_booked",
        norma_interest_level: "5",
        norma_next_action: "confirm_meeting",
      }),
    });
  });

  it("returns partial status on error", async () => {
    mockClient.crm.objects.notes.basicApi.create.mockRejectedValue(new Error("HubSpot API error"));

    const outcome: CallOutcome = {
      disposition: "interested",
      summary: "Good call",
      interestLevel: 3,
      nextAction: "follow_up",
      followUpDate: null,
      qualityScore: 70,
      dnrRequested: false,
    };

    const result = await logger.logCall({
      contactId: "contact-4",
      transcript: [],
      outcome,
      durationMs: 60000,
      recordingUrl: null,
    });

    expect(result.status).toBe("partial");
    expect(result.error).toContain("HubSpot API error");
    expect(result.callEngagementId).toBe("call-123"); // First step succeeded
  });
});

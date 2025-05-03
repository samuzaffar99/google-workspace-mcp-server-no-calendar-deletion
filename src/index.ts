#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { DateTime } from "luxon";

// Environment variables required for OAuth
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  throw new Error(
    "Required Google OAuth credentials not found in environment variables"
  );
}

class GoogleWorkspaceServer {
  private server: Server;
  private auth;
  private gmail;
  private calendar;

  constructor() {
    this.server = new Server(
      {
        name: "google-workspace-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up OAuth2 client
    this.auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    this.auth.setCredentials({ refresh_token: REFRESH_TOKEN });

    // Initialize API clients
    this.gmail = google.gmail({ version: "v1", auth: this.auth });
    this.calendar = google.calendar({ version: "v3", auth: this.auth });

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_emails",
          description: "List recent emails from Gmail inbox",
          inputSchema: {
            type: "object",
            properties: {
              maxResults: {
                type: "number",
                description: "Maximum number of emails to return (default: 10)",
              },
              query: {
                type: "string",
                description: "Search query to filter emails",
              },
            },
          },
        },
        {
          name: "search_emails",
          description: "Search emails with advanced query",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  'Gmail search query (e.g., "from:example@gmail.com has:attachment")',
              },
              maxResults: {
                type: "number",
                description: "Maximum number of emails to return (default: 10)",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "send_email",
          description: "Send a new email",
          inputSchema: {
            type: "object",
            properties: {
              to: {
                type: "string",
                description: "Recipient email address",
              },
              subject: {
                type: "string",
                description: "Email subject",
              },
              body: {
                type: "string",
                description: "Email body (can include HTML)",
              },
              cc: {
                type: "string",
                description: "CC recipients (comma-separated)",
              },
              bcc: {
                type: "string",
                description: "BCC recipients (comma-separated)",
              },
            },
            required: ["to", "subject", "body"],
          },
        },
        {
          name: "modify_email",
          description: "Modify email labels (archive, trash, mark read/unread)",
          inputSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Email ID",
              },
              addLabels: {
                type: "array",
                items: { type: "string" },
                description: "Labels to add",
              },
              removeLabels: {
                type: "array",
                items: { type: "string" },
                description: "Labels to remove",
              },
            },
            required: ["id"],
          },
        },
        {
          name: "list_events",
          description: "List upcoming calendar events",
          inputSchema: {
            type: "object",
            properties: {
              maxResults: {
                type: "number",
                description: "Maximum number of events to return (default: 10)",
              },
              timeMin: {
                type: "string",
                description: "Start time in ISO format (default: now)",
              },
              timeMax: {
                type: "string",
                description: "End time in ISO format",
              },
            },
          },
        },
        {
          name: "create_event",
          description: "Create a new calendar event",
          inputSchema: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description: "Event title",
              },
              location: {
                type: "string",
                description: "Event location",
              },
              description: {
                type: "string",
                description: "Event description",
              },
              start: {
                type: "string",
                description: "Start time in ISO format",
              },
              end: {
                type: "string",
                description: "End time in ISO format",
              },
              attendees: {
                type: "array",
                items: { type: "string" },
                description: "List of attendee email addresses",
              },
            },
            required: ["summary", "start", "end"],
          },
        },
        {
          name: "meeting_suggestion",
          description:
            "Suggest available meeting slots within the next 30 days",
          inputSchema: {
            type: "object",
            properties: {
              calendarIds: {
                type: "array",
                items: { type: "string" },
                description:
                  'List of Google Calendar IDs (default: ["primary"])',
              },
              meetingLengthMinutes: {
                type: "number",
                description: "Meeting length in minutes (default: 60)",
              },
              workingHoursStart: {
                type: "number",
                description: "Start of working hours (24h format, default: 9)",
              },
              workingHoursEnd: {
                type: "number",
                description: "End of working hours (24h format, default: 17)",
              },
              timezone: {
                type: "string",
                description:
                  "Timezone for scheduling (default: America/Sao_Paulo)",
              },
              slotsPerDay: {
                type: "number",
                description: "Number of slots per day to suggest (default: 1)",
              },
              daysToSearch: {
                type: "number",
                description: "Number of days to find slots for (default: 3)",
              },
              bankHolidays: {
                type: "array",
                items: { type: "string" },
                description: "List of bank holiday dates in YYYY-MM-DD format",
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case "list_emails":
          return await this.handleListEmails(request.params.arguments);
        case "search_emails":
          return await this.handleSearchEmails(request.params.arguments);
        case "send_email":
          return await this.handleSendEmail(request.params.arguments);
        case "modify_email":
          return await this.handleModifyEmail(request.params.arguments);
        case "list_events":
          return await this.handleListEvents(request.params.arguments);
        case "create_event":
          return await this.handleCreateEvent(request.params.arguments);
        case "meeting_suggestion":
          return await this.handleMeetingSuggestion(request.params.arguments);
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async handleListEmails(args: any) {
    try {
      const maxResults = args?.maxResults || 10;
      const query = args?.query || "";

      const response = await this.gmail.users.messages.list({
        userId: "me",
        maxResults,
        q: query,
      });

      const messages = response.data.messages || [];
      const emailDetails = await Promise.all(
        messages.map(async (msg) => {
          const detail = await this.gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
          });

          const headers = detail.data.payload?.headers;
          const subject =
            headers?.find((h) => h.name === "Subject")?.value || "";
          const from = headers?.find((h) => h.name === "From")?.value || "";
          const date = headers?.find((h) => h.name === "Date")?.value || "";

          return {
            id: msg.id,
            subject,
            from,
            date,
          };
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(emailDetails, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching emails: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleSearchEmails(args: any) {
    try {
      const maxResults = args?.maxResults || 10;
      const query = args?.query || "";

      const response = await this.gmail.users.messages.list({
        userId: "me",
        maxResults,
        q: query,
      });

      const messages = response.data.messages || [];
      const emailDetails = await Promise.all(
        messages.map(async (msg) => {
          const detail = await this.gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
          });

          const headers = detail.data.payload?.headers;
          const subject =
            headers?.find((h) => h.name === "Subject")?.value || "";
          const from = headers?.find((h) => h.name === "From")?.value || "";
          const date = headers?.find((h) => h.name === "Date")?.value || "";

          return {
            id: msg.id,
            subject,
            from,
            date,
          };
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(emailDetails, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching emails: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleSendEmail(args: any) {
    try {
      const { to, subject, body, cc, bcc } = args;

      // Create email content
      const message = [
        "Content-Type: text/html; charset=utf-8",
        "MIME-Version: 1.0",
        `To: ${to}`,
        cc ? `Cc: ${cc}` : "",
        bcc ? `Bcc: ${bcc}` : "",
        `Subject: ${subject}`,
        "",
        body,
      ]
        .filter(Boolean)
        .join("\r\n");

      // Encode the email
      const encodedMessage = Buffer.from(message)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Send the email
      const response = await this.gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: encodedMessage,
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `Email sent successfully. Message ID: ${response.data.id}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error sending email: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleModifyEmail(args: any) {
    try {
      const { id, addLabels = [], removeLabels = [] } = args;

      const response = await this.gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: {
          addLabelIds: addLabels,
          removeLabelIds: removeLabels,
        },
      });

      return {
        content: [
          {
            type: "text",
            text: `Email modified successfully. Updated labels for message ID: ${response.data.id}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error modifying email: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleCreateEvent(args: any) {
    try {
      const {
        summary,
        location,
        description,
        start,
        end,
        attendees = [],
      } = args;

      const event = {
        summary,
        location,
        description,
        start: {
          dateTime: start,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        end: {
          dateTime: end,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        attendees: attendees.map((email: string) => ({ email })),
      };

      const response = await this.calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });

      return {
        content: [
          {
            type: "text",
            text: `Event created successfully. Event ID: ${response.data.id}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating event: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleListEvents(args: any) {
    try {
      const maxResults = args?.maxResults || 10;
      const timeMin = args?.timeMin || new Date().toISOString();
      const timeMax = args?.timeMax;

      const response = await this.calendar.events.list({
        calendarId: "camilagolin3@gmail.com",
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items?.map((event) => ({
        id: event.id,
        summary: event.summary,
        start: event.start,
        end: event.end,
        location: event.location,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(events, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching calendar events: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleMeetingSuggestion(args: any) {
    try {
      const meetingLength = args?.meetingLengthMinutes || 60;
      const workStartHour = args?.workingHoursStart || 9;
      const workEndHour = args?.workingHoursEnd || 17;
      const timezone = args?.timezone || "America/Sao_Paulo";
      const slotsPerDay = args?.slotsPerDay || 1;
      const daysToSearch = args?.daysToSearch || 3;
      const maxDaysToLookAhead = args?.maxDaysToLookAhead || 30; // New parameter with default
      const bankHolidays = args?.bankHolidays || [];
      const calendarIds = args?.calendarIds || ["primary"];

      // Corrected timezone-aware logic using Luxon
      const suggestions: any[] = [];
      let daysWithSlotsFound = 0; // Track days with slots

      let startDate;
      if (args?.startDate) {
        startDate = DateTime.fromISO(args.startDate, {
          zone: timezone,
        }).startOf("day");
      } else {
        // Default to tomorrow in the specified timezone
        startDate = DateTime.now()
          .setZone(timezone)
          .plus({ days: 1 })
          .startOf("day");
      }

      const endDate = startDate.plus({ days: maxDaysToLookAhead }).endOf("day");

      const busyResponse = await this.calendar.freebusy.query({
        requestBody: {
          timeMin: startDate.toISO(),
          timeMax: endDate.toISO(),
          timeZone: timezone,
          items: calendarIds.map((id: string) => ({ id })),
        },
      });

      console.log(
        "##########################################################################\n"
      );
      console.log(
        "##########################################################################\n"
      );
      console.log(
        "##########################################################################\n"
      );
      console.log(
        "Freebusy Response:",
        JSON.stringify(busyResponse.data, null, 2)
      );

      const busySlots = calendarIds
        .flatMap((id: string) => busyResponse.data.calendars?.[id]?.busy || [])
        .filter(
          (slot: {
            start?: string;
            end?: string;
          }): slot is { start: string; end: string } =>
            !!slot.start && !!slot.end
        );

      let dayPointer = startDate; // Luxon DateTime
      while (daysWithSlotsFound < daysToSearch && dayPointer < endDate) {
        const dayOfWeek = dayPointer.weekday;
        const formattedDate = dayPointer.toISODate();
        if (dayOfWeek < 6 && !bankHolidays.includes(formattedDate)) {
          // Ensure dayPointer is a DateTime object in your timezone

          let dayStart = dayPointer.set({
            hour: workStartHour,
            minute: 0,
            second: 0,
            millisecond: 0,
          });
          let dayEnd = dayPointer.set({
            hour: workEndHour,
            minute: 0,
            second: 0,
            millisecond: 0,
          });

          // Now explicitly pass native Dates to your findFreeSlots
          const freeSlots = this.findFreeSlots(
            busySlots,
            dayStart.toJSDate(),
            dayEnd.toJSDate(),
            meetingLength
          );

          console.log(
            "###### Busy slots received####################################################################\n"
          );
          console.log("Busy slots received:", busySlots);
          console.log(
            "###### FREE slots received####################################################################\n"
          );
          console.log("Free slots calculated:", freeSlots);

          // Collect up to `slotsPerDay` slots for this day
          let slotsAddedToday = 0;
          for (const slot of freeSlots) {
            if (slotsAddedToday >= slotsPerDay) break;
            suggestions.push({
              start: DateTime.fromJSDate(slot.start).setZone(timezone).toISO(),
              end: DateTime.fromJSDate(slot.end).setZone(timezone).toISO(),
            });
            slotsAddedToday++;
          }

          daysWithSlotsFound++; // counts this day as processed
        }

        dayPointer = dayPointer.plus({ days: 1 });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(suggestions, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error suggesting meetings: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private findFreeSlots(
    busySlots: Array<{ start: string; end: string }>,
    dayStart: Date,
    dayEnd: Date,
    meetingLengthMinutes: number
  ): Array<{ start: Date; end: Date }> {
    const freeSlots: Array<{ start: Date; end: Date }> = [];
    let pointer = new Date(dayStart);

    // Sort busy slots
    const sortedBusySlots = busySlots
      .filter(
        (slot) => new Date(slot.start) < dayEnd && new Date(slot.end) > dayStart
      )
      .sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
      );

    for (const busy of sortedBusySlots) {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);

      // While loop to add multiple slots before busyStart
      while (
        busyStart.getTime() - pointer.getTime() >=
        meetingLengthMinutes * 60000
      ) {
        freeSlots.push({
          start: new Date(pointer),
          end: new Date(pointer.getTime() + meetingLengthMinutes * 60000),
        });
        pointer.setTime(pointer.getTime() + meetingLengthMinutes * 60000);
      }

      // Move pointer to after the busy slot if pointer overlaps busy
      if (pointer < busyEnd) pointer = new Date(busyEnd);
    }

    // After last busy slot: fill remaining time until dayEnd
    while (
      dayEnd.getTime() - pointer.getTime() >=
      meetingLengthMinutes * 60000
    ) {
      freeSlots.push({
        start: new Date(pointer),
        end: new Date(pointer.getTime() + meetingLengthMinutes * 60000),
      });
      pointer.setTime(pointer.getTime() + meetingLengthMinutes * 60000);
    }

    return freeSlots;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Google Workspace MCP server running on stdio");
  }
}

const server = new GoogleWorkspaceServer();
server.run().catch(console.error);

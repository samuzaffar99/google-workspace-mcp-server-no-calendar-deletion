#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';

// Environment variables required for OAuth
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  throw new Error('Required Google OAuth credentials not found in environment variables');
}

class GoogleWorkspaceServer {
  private server: Server;
  private auth;
  private gmail;
  private calendar;

  constructor() {
    this.server = new Server(
      {
        name: 'google-workspace-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // OAuth2 client
    this.auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    this.auth.setCredentials({ refresh_token: REFRESH_TOKEN });

    // Initialize API clients
    this.gmail = google.gmail({ version: 'v1', auth: this.auth });
    this.calendar = google.calendar({ version: 'v3', auth: this.auth });

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'meeting_suggestion',
          description: 'Suggest available meeting slots within the next 30 days',
          inputSchema: {
            type: 'object',
            properties: {
              calendarIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of Google Calendar IDs (default: ["primary"])',
              },
              meetingLengthMinutes: {
                type: 'number',
                description: 'Meeting length in minutes (default: 60)',
              },
              workingHoursStart: {
                type: 'number',
                description: 'Start of working hours (24h, default: 9)',
              },
              workingHoursEnd: {
                type: 'number',
                description: 'End of working hours (24h, default: 17)',
              },
              timezone: {
                type: 'string',
                description: 'Timezone (default: America/Sao_Paulo)',
              },
              slotsPerDay: {
                type: 'number',
                description: 'Number of slots per day (default: 1)',
              },
              daysToSearch: {
                type: 'number',
                description: 'Number of days to suggest slots for (default: 3)',
              },
              bankHolidays: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bank holiday dates (YYYY-MM-DD)',
              },
              startDate: {
                type: 'string',
                description: 'Start date in ISO format (default: tomorrow)',
              },
              maxDaysToLookAhead: {
                type: 'number',
                description: 'Max days to search ahead (default: 30)',
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'meeting_suggestion':
          return await this.handleMeetingSuggestion(request.params.arguments);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleMeetingSuggestion(args: any) {
    try {
      const meetingLength = args?.meetingLengthMinutes || 60;
      const workStartHour = args?.workingHoursStart || 9;
      const workEndHour = args?.workingHoursEnd || 17;
      const timezone = args?.timezone || 'America/Sao_Paulo';
      const slotsPerDay = args?.slotsPerDay || 1;
      const daysToSearch = args?.daysToSearch || 3;
      const maxDaysToLookAhead = args?.maxDaysToLookAhead || 30;
      const bankHolidays = args?.bankHolidays || [];
      const calendarIds = args?.calendarIds || ['primary'];

      let startDate = args?.startDate ? new Date(args.startDate) : new Date();
      startDate = new Date(startDate.toLocaleString('en-US', { timeZone: timezone }));
      startDate.setDate(startDate.getDate() + (args?.startDate ? 0 : 1));
      startDate.setHours(0, 0, 0, 0);

      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + maxDaysToLookAhead);

      const busyResponse = await this.calendar.freebusy.query({
        requestBody: {
          timeMin: startDate.toISOString(),
          timeMax: endDate.toISOString(),
          timeZone: timezone,
          items: calendarIds.map((id: string) => ({ id })),
        },
      });

      const busySlots = calendarIds.flatMap(
        (id: string) => busyResponse.data.calendars?.[id]?.busy || []
      ).filter((slot: { start?: string; end?: string }): slot is { start: string; end: string } => !!slot.start && !!slot.end);

      const suggestions: any[] = [];
      let daysWithSlotsFound = 0;

      const dayPointer = new Date(startDate);

      while (daysWithSlotsFound < daysToSearch && dayPointer < endDate) {
        const dayOfWeek = dayPointer.getDay();
        const formattedDate = dayPointer.toISOString().split('T')[0];

        if (dayOfWeek !== 0 && dayOfWeek !== 6 && !bankHolidays.includes(formattedDate)) {
          const dayStart = new Date(dayPointer);
          dayStart.setHours(workStartHour, 0, 0, 0);

          const dayEnd = new Date(dayPointer);
          dayEnd.setHours(workEndHour, 0, 0, 0);

          const freeSlots = this.findFreeSlots(busySlots, dayStart, dayEnd, meetingLength);

          if (freeSlots.length > 0) {
            suggestions.push(...freeSlots.slice(0, slotsPerDay).map(slot => ({
              start: slot.start.toISOString(),
              end: slot.end.toISOString(),
            })));
            daysWithSlotsFound++;
          }
        }

        dayPointer.setDate(dayPointer.getDate() + 1);
      }

      return { content: [{ type: 'text', text: JSON.stringify(suggestions, null, 2) }] };

    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
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

    const sortedBusySlots = busySlots
      .filter(slot => new Date(slot.start) < dayEnd && new Date(slot.end) > dayStart)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    for (const busy of sortedBusySlots) {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);

      if (pointer < busyStart) {
        const gapMinutes = (busyStart.getTime() - pointer.getTime()) / (60 * 1000);
        if (gapMinutes >= meetingLengthMinutes) {
          freeSlots.push({
            start: new Date(pointer),
            end: new Date(pointer.getTime() + meetingLengthMinutes * 60000),
          });
        }
      }
      if (pointer < busyEnd) pointer = new Date(busyEnd);
    }

    if (pointer < dayEnd) {
      const gapMinutes = (dayEnd.getTime() - pointer.getTime()) / (60 * 1000);
      if (gapMinutes >= meetingLengthMinutes) {
        freeSlots.push({
          start: new Date(pointer),
          end: new Date(pointer.getTime() + meetingLengthMinutes * 60000),
        });
      }
    }

    return freeSlots;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Google Workspace MCP server running on stdio');
  }
}

const server = new GoogleWorkspaceServer();
server.run().catch(console.error);

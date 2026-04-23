import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Core } from '@ledric/core';

const FieldDefSchema: z.ZodTypeAny = z
  .lazy(() =>
    z.object({
      type: z.string(),
      description: z.string().optional(),
      required: z.boolean().optional(),
      deprecated: z.boolean().optional(),
      indexed: z.boolean().optional()
    }).passthrough()
  );

const TypeDefOptionsSchema = z
  .object({
    description: z.string().optional(),
    identifier_field: z.string().optional(),
    display_field: z.string().optional(),
    summary_fields: z.array(z.string()).optional(),
    on_slug_change: z.enum(['redirect', 'error', 'silent']).optional(),
    example: z.record(z.unknown()).optional()
  })
  .strict();

const CreateTypeArgsSchema = z
  .object({
    name: z.string(),
    fields: z.record(FieldDefSchema),
    opts: TypeDefOptionsSchema.optional(),
    author: z.string().optional()
  })
  .strict();

export const SERVER_NAME = 'ledric';
export const SERVER_VERSION = '0.0.0';

export function createMcpServer(core: Core): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'describe_model',
        description:
          "Return the full content model: every type's fields, summary fields, example, plus the runtime capabilities of this ledric instance.",
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: 'create_type',
        description:
          'Create a new content type. Fields values follow the canonical JSON form from @ledric/schema. The returned object is the newly-written type at version 1.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The type name. Lowercase, must match /^[a-z][a-z0-9_]*$/.'
            },
            fields: {
              type: 'object',
              description: 'Map of field name → FieldDef (each has a "type" discriminator).',
              additionalProperties: { type: 'object' }
            },
            opts: {
              type: 'object',
              description: 'Optional type-level settings.',
              properties: {
                description: { type: 'string' },
                identifier_field: { type: 'string' },
                display_field: { type: 'string' },
                summary_fields: { type: 'array', items: { type: 'string' } },
                on_slug_change: { enum: ['redirect', 'error', 'silent'] },
                example: { type: 'object' }
              },
              additionalProperties: false
            },
            author: { type: 'string' }
          },
          required: ['name', 'fields'],
          additionalProperties: false
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        case 'describe_model': {
          const result = await core.describeModel();
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        case 'create_type': {
          const parsed = CreateTypeArgsSchema.parse(args ?? {});
          const result = await core.createType(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: message }]
      };
    }
  });

  return server;
}

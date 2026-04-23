import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import { createMcpServer } from './server.js';

interface TextBlock {
  type: 'text';
  text: string;
}

function firstText(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('tool response had no content');
  }
  const block = content[0] as TextBlock;
  if (block.type !== 'text') {
    throw new Error(`expected text block, got ${block.type}`);
  }
  return block.text;
}

describe('MCP server (in-memory round trip)', () => {
  let storage: SqliteStorage;
  let client: Client;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    const core = new Core(storage);
    const server = createMcpServer(core);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('lists the two slice tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['create_type', 'describe_model']);
  });

  it('describe_model on an empty DB has no types', async () => {
    const result = await client.callTool({ name: 'describe_model' });
    const parsed = JSON.parse(firstText(result.content));
    expect(parsed.types).toEqual({});
    expect(parsed.schema_version).toBe(0);
  });

  it('create_type then describe_model round trip', async () => {
    const created = await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'product',
        fields: {
          title: { type: 'string', required: true, max: 120 },
          price: { type: 'number', min: 0 }
        },
        opts: { summary_fields: ['title', 'price'] }
      }
    });
    const createdParsed = JSON.parse(firstText(created.content));
    expect(createdParsed.name).toBe('product');
    expect(createdParsed.version).toBe(1);

    const described = await client.callTool({ name: 'describe_model' });
    const describedParsed = JSON.parse(firstText(described.content));
    expect(Object.keys(describedParsed.types)).toEqual(['product']);
    expect(describedParsed.types.product.fields.title.max).toBe(120);
    expect(describedParsed.schema_version).toBe(1);
  });

  it('surfaces validation errors as isError tool responses', async () => {
    const result = await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'Bad-Name',
        fields: { title: { type: 'string' } }
      }
    });
    expect(result.isError).toBe(true);
    expect(firstText(result.content)).toMatch(/type name/);
  });
});

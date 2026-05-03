import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Core } from '@ledric/core';
import { createMcpServer } from './server.js';

/**
 * Streamable HTTP transport for MCP.
 *
 * Adds an HTTP-shaped MCP surface alongside the stdio transport — same
 * tool catalogue, same `core` dispatch, no second tool implementation.
 *
 * Session model: stateful, per-session transport instance kept in an
 * in-memory Map. The MCP SDK generates a fresh `Mcp-Session-Id` on the
 * first `initialize` call and the client carries it on every
 * subsequent request (POST for JSON-RPC, GET for the optional SSE
 * stream, DELETE to terminate).
 *
 * The `handle` function returned here is shaped for Fastify (or any
 * adapter that hands us Node's IncomingMessage + ServerResponse +
 * a pre-parsed body). The HTTP server mounts it under `POST /mcp` /
 * `GET /mcp` / `DELETE /mcp`.
 */
export interface StreamableHttpHandle {
  /**
   * Handle one HTTP request. Caller is responsible for auth / Origin
   * checks before delegating here. After this resolves, the response
   * has been written and the framework should not write further.
   */
  handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
  /** Tear down all live sessions — call on server shutdown. */
  close(): Promise<void>;
  /** Number of live sessions. Mostly for tests / metrics. */
  readonly sessionCount: number;
}

export function createStreamableHttpHandle(core: Core): StreamableHttpHandle {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function startSession(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      }
    });
    transport.onclose = () => {
      // Reading sessionId after onclose still works — the SDK sets it
      // synchronously during initialize, before the first tool call.
      const sid = transport.sessionId;
      if (sid !== undefined) sessions.delete(sid);
    };
    const server = createMcpServer(core);
    await server.connect(transport);
    return transport;
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ): Promise<void> {
    const sid = headerValue(req.headers['mcp-session-id']);
    let transport: StreamableHTTPServerTransport;

    if (sid !== undefined && sessions.has(sid)) {
      transport = sessions.get(sid)!;
    } else if (sid === undefined && req.method === 'POST' && isInitializeRequest(body)) {
      transport = await startSession();
    } else {
      // Non-init request without a known session — reject per spec.
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              sid === undefined
                ? 'Mcp-Session-Id header required for non-initialize requests'
                : 'Unknown or expired Mcp-Session-Id'
          },
          id: null
        })
      );
      return;
    }

    await transport.handleRequest(req, res, body);
  }

  async function close(): Promise<void> {
    const all = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(all.map((t) => t.close().catch(() => undefined)));
  }

  return {
    handle,
    close,
    get sessionCount() {
      return sessions.size;
    }
  };
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

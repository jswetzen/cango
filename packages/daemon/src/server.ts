import { existsSync, unlinkSync } from "node:fs";
import type { Socket } from "bun";
import { dispatch, RpcError, type RpcContext } from "./rpc.ts";
import { encodeFrame, FrameDecoder } from "./framing.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ConnState {
  decoder: FrameDecoder;
}

export interface SocketServer {
  stop(): void;
}

export function startServer(
  socketPath: string,
  ctx: RpcContext,
  log: (msg: string) => void = () => {},
): SocketServer {
  if (existsSync(socketPath)) {
    // Stale socket from a previous run.
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  }

  const server = Bun.listen<ConnState>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { decoder: new FrameDecoder() };
      },
      data(socket, chunk) {
        let frames: unknown[];
        try {
          frames = socket.data.decoder.push(new Uint8Array(chunk));
        } catch (err) {
          log(`frame error: ${String(err)}`);
          socket.end();
          return;
        }
        for (const frame of frames) {
          void handleRequest(socket, frame as JsonRpcRequest, ctx, log);
        }
      },
    },
  });

  log(`listening on ${socketPath}`);
  return {
    stop() {
      server.stop(true);
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // ignore
        }
      }
    },
  };
}

async function handleRequest(
  socket: Socket<ConnState>,
  req: JsonRpcRequest,
  ctx: RpcContext,
  log: (msg: string) => void,
): Promise<void> {
  const id = req.id ?? null;
  if (!req.method || typeof req.method !== "string") {
    send(socket, errorResponse(id, -32600, "invalid request: missing method"));
    return;
  }
  try {
    const result = await dispatch(ctx, req.method, req.params);
    send(socket, { jsonrpc: "2.0", id, result });
  } catch (err) {
    if (err instanceof RpcError) {
      send(socket, errorResponse(id, err.code, err.message, err.data));
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`handler error (${req.method}): ${message}`);
    send(socket, errorResponse(id, -32603, message));
  }
}

function send(socket: Socket<ConnState>, payload: unknown): void {
  socket.write(encodeFrame(payload));
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

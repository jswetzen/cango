import { encodeFrame, FrameDecoder } from "./framing.ts";

interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingClient {
  decoder: FrameDecoder;
  onFrame: (frame: unknown) => void;
}

/**
 * Minimal one-shot JSON-RPC client over the Unix socket. Opens a connection,
 * sends a single request, resolves with the result (or rejects on RPC error).
 */
export async function rpcCall(
  socketPath: string,
  method: string,
  params?: unknown,
  id: string | number = 1,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    Bun.connect<PendingClient>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = {
            decoder: new FrameDecoder(),
            onFrame: (frame) => {
              const res = frame as JsonRpcResponse;
              socket.end();
              if (res.error) {
                finish(() =>
                  reject(
                    new Error(`RPC error ${res.error!.code}: ${res.error!.message}`),
                  ),
                );
              } else {
                finish(() => resolve(res.result));
              }
            },
          };
          socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
        },
        data(socket, chunk) {
          let frames: unknown[];
          try {
            frames = socket.data.decoder.push(new Uint8Array(chunk));
          } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
            return;
          }
          for (const frame of frames) socket.data.onFrame(frame);
        },
        error(_socket, err) {
          finish(() => reject(err));
        },
        connectError(_socket, err) {
          finish(() => reject(err));
        },
      },
    });
  });
}

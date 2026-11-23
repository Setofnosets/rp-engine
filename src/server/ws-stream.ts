import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionEventBus, SessionRuntimeEvent } from '../runtime/event-bus.js';

/**
 * Manages Server-Sent Events (`text/event-stream`) connections per session ID,
 * subscribing to each session's {@link SessionEventBus} and broadcasting JSON event frames.
 */
export class SessionSseHub {
  private readonly clientsBySession = new Map<string, Set<ServerResponse>>();
  private readonly busUnsubscribers = new Map<string, () => void>();

  /**
   * Subscribe this hub to `eventBus` notifications for `sessionId`.
   * Replaces any prior subscription for the same `sessionId`.
   */
  attachSession(sessionId: string, eventBus: SessionEventBus): void {
    const existingUnsub = this.busUnsubscribers.get(sessionId);
    if (existingUnsub !== undefined) {
      existingUnsub();
    }

    const unsubscribe = eventBus.on((event) => {
      this.broadcast(sessionId, event);
    });
    this.busUnsubscribers.set(sessionId, unsubscribe);
  }

  /**
   * Unsubscribe from `sessionId`'s event bus and close any open SSE streams for that session.
   */
  detachSession(sessionId: string): void {
    const unsubscribe = this.busUnsubscribers.get(sessionId);
    if (unsubscribe !== undefined) {
      unsubscribe();
      this.busUnsubscribers.delete(sessionId);
    }

    const clients = this.clientsBySession.get(sessionId);
    if (clients !== undefined) {
      for (const res of [...clients]) {
        clients.delete(res);
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.end();
          } catch {
            // Ignore close errors on already-terminated sockets.
          }
        }
      }
      this.clientsBySession.delete(sessionId);
    }
  }

  /**
   * Register an HTTP response as an active SSE listener for `sessionId`,
   * sending SSE headers immediately and detaching automatically on disconnect.
   */
  addClient(sessionId: string, res: ServerResponse, req?: IncomingMessage): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    let clients = this.clientsBySession.get(sessionId);
    if (clients === undefined) {
      clients = new Set<ServerResponse>();
      this.clientsBySession.set(sessionId, clients);
    }
    clients.add(res);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      res.off('close', cleanup);
      res.off('error', cleanup);
      req?.off('close', cleanup);

      const setForSession = this.clientsBySession.get(sessionId);
      if (setForSession !== undefined) {
        setForSession.delete(res);
        if (setForSession.size === 0) {
          this.clientsBySession.delete(sessionId);
        }
      }
    };

    res.on('close', cleanup);
    res.on('error', cleanup);
    req?.on('close', cleanup);

    if (!res.writableEnded && !res.destroyed) {
      try {
        res.write(': connected\n\n');
      } catch {
        cleanup();
      }
    } else {
      cleanup();
    }

    return cleanup;
  }

  /**
   * Broadcast a {@link SessionRuntimeEvent} as an SSE `event: <type>\ndata: <json>\n\n` frame
   * to all active clients subscribed to `sessionId`.
   */
  broadcast(sessionId: string, event: SessionRuntimeEvent): void {
    const clients = this.clientsBySession.get(sessionId);
    if (clients === undefined || clients.size === 0) {
      return;
    }

    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of [...clients]) {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
        try {
          if (!res.writableEnded && !res.destroyed) {
            res.destroy();
          }
        } catch {
          // Ignore destroy errors.
        }
      }
    }

    if (clients.size === 0) {
      this.clientsBySession.delete(sessionId);
    }
  }

  /**
   * Return the active SSE client count for a specific session or across all sessions.
   */
  getClientCount(sessionId?: string): number {
    if (sessionId !== undefined) {
      return this.clientsBySession.get(sessionId)?.size ?? 0;
    }
    let total = 0;
    for (const clients of this.clientsBySession.values()) {
      total += clients.size;
    }
    return total;
  }

  /**
   * Unsubscribe from all session event buses and end every active SSE response stream.
   */
  closeAll(): void {
    for (const unsubscribe of this.busUnsubscribers.values()) {
      unsubscribe();
    }
    this.busUnsubscribers.clear();

    for (const clients of this.clientsBySession.values()) {
      for (const res of [...clients]) {
        clients.delete(res);
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.end();
          } catch {
            // Ignore close errors.
          }
        }
      }
    }
    this.clientsBySession.clear();
  }
}

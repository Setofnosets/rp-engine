import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelGateway } from '../gateway/model-gateway.js';
import { DaemonRegistry, createDaemonRequestHandler } from './routes.js';

export interface RefereeDaemonOptions {
  readonly host?: string;
  readonly port?: number;
  readonly gateway?: ModelGateway;
  readonly dataDir?: string;
  readonly connectionsPath?: string;
}

export interface DaemonAddressInfo {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

/**
 * Localhost-bound HTTP & SSE service daemon exposing Referee session,
 * cartridge, Control Room, Wizard, and ST-Bridge endpoints over Node `node:http`.
 */
export class RefereeDaemon {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly registry: DaemonRegistry;
  private readonly server: Server;
  private activeInfo: DaemonAddressInfo | null = null;
  private startPromise: Promise<DaemonAddressInfo> | null = null;

  constructor(options: RefereeDaemonOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 4120;
    this.registry = new DaemonRegistry({
      ...(options.gateway !== undefined ? { gateway: options.gateway } : {}),
      ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      ...(options.connectionsPath !== undefined ? { connectionsPath: options.connectionsPath } : {}),
    });

    const handler = createDaemonRequestHandler(this.registry);
    this.server = createServer((req, res) => {
      void handler(req, res);
    });
  }

  /**
   * Return the daemon's {@link DaemonRegistry}.
   */
  getRegistry(): DaemonRegistry {
    return this.registry;
  }

  /**
   * Bind and start listening on `host:port` (supporting `port: 0` ephemeral assignment).
   */
  async start(): Promise<DaemonAddressInfo> {
    if (this.activeInfo !== null && this.server.listening) {
      return this.activeInfo;
    }
    if (this.startPromise !== null) {
      return this.startPromise;
    }

    this.startPromise = (async (): Promise<DaemonAddressInfo> => {
      try {
        await this.registry.init();
      } catch (error) {
        this.startPromise = null;
        throw error;
      }

      return await new Promise<DaemonAddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => {
          this.server.off('listening', onListening);
          this.startPromise = null;
          reject(error);
        };

        const onListening = (): void => {
          this.server.off('error', onError);
          const rawAddr = this.server.address();
          if (rawAddr === null || typeof rawAddr === 'string') {
            this.startPromise = null;
            reject(new Error('HTTP server did not return a TCP AddressInfo'));
            return;
          }
          const addrInfo = rawAddr as AddressInfo;
          const hostForUrl = this.host.includes(':') ? `[${this.host}]` : this.host;
          const info: DaemonAddressInfo = {
            host: this.host,
            port: addrInfo.port,
            url: `http://${hostForUrl}:${addrInfo.port}`,
          };
          this.activeInfo = info;
          this.startPromise = null;
          resolve(info);
        };

        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(this.requestedPort, this.host);
      });
    })();

    return this.startPromise;
  }

  /**
   * Close all SSE streams and shut down the underlying HTTP server cleanly.
   */
  async stop(): Promise<void> {
    this.registry.sseHub.closeAll();
    this.activeInfo = null;
    this.startPromise = null;

    if (!this.server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
      if (typeof this.server.closeAllConnections === 'function') {
        this.server.closeAllConnections();
      }
    });
  }
}

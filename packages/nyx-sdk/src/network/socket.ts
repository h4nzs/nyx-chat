import { EventEmitter } from 'eventemitter3';
import { io, Socket } from 'socket.io-client';

// We allow `any` here to comply with standard EventEmitter/Socket.io event payloads
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventPayload = any;

export class NyxSocketClient extends EventEmitter {
  private socket: Socket | null = null;

  public get connected(): boolean {
    return this.socket !== null && this.socket.connected;
  }

  public connect(url: string, token: string): void {
    if (this.socket) {
      this.socket.disconnect();
    }

    this.socket = io(url, {
      auth: { token },
      autoConnect: true,
      transports: ['websocket', 'polling']
    });

    this.socket.on('connect', () => {
      this.emit('connect');
    });

    this.socket.on('disconnect', (reason) => {
      this.emit('disconnect', reason);
    });

    this.socket.on('connect_error', (error) => {
      this.emit('connect_error', error);
    });

    // We can proxy all other events if needed, but usually we listen for specific ones
    // or provide a method to subscribe to custom events.
    // For a generalized proxy:
    this.socket.onAny((event: string, ...args: EventPayload[]) => {
      // Don't re-emit internal socket.io events that we already handle
      if (!['connect', 'disconnect', 'connect_error'].includes(event)) {
        this.emit(event, ...args);
      }
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  public emitEvent(event: string, payload: EventPayload): void {
    if (!this.socket || !this.socket.connected) {
      throw new Error('Socket is not connected');
    }
    this.socket.emit(event, payload);
  }
}

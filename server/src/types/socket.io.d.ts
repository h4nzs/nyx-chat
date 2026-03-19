import { AuthPayload } from './auth';

declare module 'socket.io' {
  interface Socket {
    user?: AuthPayload;
  }
}

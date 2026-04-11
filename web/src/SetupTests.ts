import '@testing-library/jest-dom';
import { Buffer } from 'buffer';

// Polyfill Buffer for jsdom environment
global.Buffer = Buffer;

// Mock localStorage
const localStorageMock = (function() {
  let store: Record<string, string> = {};
  return {
    getItem: function(key: string) {
      return store[key] || null;
    },
    setItem: function(key: string, value: string) {
      store[key] = value.toString();
    },
    removeItem: function(key: string) {
      delete store[key];
    },
    clear: function() {
      store = {};
    }
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock Web Worker
class WorkerMock {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  constructor(stringUrl: string) {
    this.url = stringUrl;
    this.onmessage = null;
  }
  postMessage(msg: unknown) {
    // Mock worker behavior or just ignore
  }
  terminate() {}
}
global.Worker = WorkerMock as unknown as typeof global.Worker;

import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from '../../src/protocol/messages';
import { isHostToWebviewMessage } from '../../src/protocol/messages';

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi(): VsCodeApi;
  }
}

export interface MessageBus {
  post(message: WebviewToHostMessage): void;
  subscribe(handler: (message: HostToWebviewMessage) => void): () => void;
}

export function createMessageBus(): MessageBus {
  const api = window.acquireVsCodeApi();
  return {
    post(message) {
      api.postMessage(message);
    },
    subscribe(handler) {
      const listener = (event: MessageEvent): void => {
        if (isHostToWebviewMessage(event.data)) handler(event.data);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
    },
  };
}

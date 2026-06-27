declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

declare function setTimeout(handler: () => void, timeout?: number): number;

declare const navigator: {
  readonly userAgent: string;
};

declare class URL {
  constructor(url: string);
  readonly protocol: string;
}

declare class MessageEvent<T = unknown> {
  readonly data: T;
}

declare class CloseEvent {
  readonly code: number;
}

type WebSocketEventHandler = () => void | Promise<void>;
type WebSocketMessageHandler = (event: MessageEvent<string>) => void;
type WebSocketCloseHandler = (event: CloseEvent) => void;

declare class WebSocket {
  static readonly CONNECTING: number;
  static readonly OPEN: number;
  readonly readyState: number;
  onopen: WebSocketEventHandler | null;
  onmessage: WebSocketMessageHandler | null;
  onclose: WebSocketCloseHandler | null;
  onerror: WebSocketEventHandler | null;
  constructor(url: string);
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

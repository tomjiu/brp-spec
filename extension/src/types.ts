export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue | undefined }

export type MessageId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: MessageId;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: MessageId;
  result?: JsonValue;
  error?: JsonObject;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
}

export type BridgeMessage = JsonRpcResponse | JsonRpcNotification;

export interface SelectorObject extends JsonObject {
  type?: string;
  value?: JsonValue;
}

export interface NavigationDecision {
  block: boolean;
  reason?: string;
}

export interface TabTracker {
  add(tabId: number): void;
  remove(tabId: number): boolean;
  has(tabId: number): boolean;
  getAll(): Set<number>;
  readonly size: number;
  clear(): void;
}

export type DirectHandlerName =
  | "handleInitialize"
  | "handleShutdown"
  | "handleTabList"
  | "handleTabOpen"
  | "handleTabClose"
  | "handleTabSelect"
  | "handleTabSetControllable"
  | "handlePageNavigate"
  | "handleGetITree"
  | "handleScreenshot"
  | "handleKeyboardPress"
  | "handleGoBack"
  | "handleGoForward"
  | "handleReload"
  | "handleScriptExecute"
  | "handleHistorySearch"
  | "handleHistoryDelete";

export type ElementAction =
  | "click"
  | "type"
  | "fill"
  | "scroll"
  | "hover"
  | "select"
  | "getAttribute"
  | "waitForSelector";

export type MethodRoute =
  | { type: "direct"; handler: DirectHandlerName }
  | { type: "elementAction"; action: ElementAction };

export interface InitializeResult extends JsonObject {
  sessionId: string;
  protocolVersion: string;
  negotiatedVersion: string;
  serverInfo: { name: string; version: string } & JsonObject;
  capabilities: {
    features: string[];
    actions: string[];
    treeDeltaSupported: boolean;
    multiSession: boolean;
  } & JsonObject;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(value: JsonObject | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" ? item : undefined;
}

export function getNumber(value: JsonObject | undefined, key: string): number | undefined {
  const item = value?.[key];
  return typeof item === "number" ? item : undefined;
}

export function getBoolean(value: JsonObject | undefined, key: string): boolean | undefined {
  const item = value?.[key];
  return typeof item === "boolean" ? item : undefined;
}

export function getObject(value: JsonObject | undefined, key: string): JsonObject | undefined {
  const item = value?.[key];
  return isJsonObject(item) ? item : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

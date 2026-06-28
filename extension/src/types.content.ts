/**
 * BRP Content Script Types
 *
 * Shared types for content.ts and itree.ts.
 * These are separate from types.ts (background-side) to avoid DOM dependencies
 * leaking into the background build.
 */

import type { JsonValue } from "./types";

// ─── Content Message (from background) ───

export interface ContentMessage {
  action: string;
  selector?: SelectorValue;
  selectors?: SelectorValue[];
  nodeId?: string;
  text?: string;
  value?: string;
  values?: string[];
  code?: string;
  key?: string;
  css?: string;
  timeout?: number;
  attribute?: string;
  precondition?: Precondition;
}

// ─── Precondition (E3) ───

export interface Precondition {
  tagName?: string;
  textContains?: string;
  attributes?: Record<string, string>;
}

// ─── Selectors ───

export interface SelectorValue {
  type: SelectorType;
  value?: unknown;
}

export type SelectorType = "nodeId" | "css" | "xpath" | "role" | "text" | "coordinate";

export interface RoleSelectorValue {
  role: string;
  name?: string;
}

export interface CoordinateSelectorValue {
  x: number;
  y: number;
}

// ─── ITree ───

export interface ITreeNode {
  nodeId: string;
  role: string;
  name: string;
  tag: string;
  visible: boolean;
  bounds: Bounds;
  children?: ITreeNode[];
  value?: string;
  redacted?: boolean;
  checked?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  href?: string;
  src?: string;
  inputType?: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ITreeResult {
  revision: number;
  url: string;
  title: string;
  root: ITreeNode;
  nodeCount: number;
}

export interface ITreeAPI {
  buildInteractionTree(): ITreeResult;
  findElement(
    selector?: SelectorValue,
    selectors?: SelectorValue[],
    nodeId?: string,
  ): Element | null;
  getRevision(): number;
}

// ─── Content Action Results ───

export type ContentResult =
  | ContentSuccess
  | ContentSuccess<string>
  | ContentError;

export interface ContentSuccess<T = void> {
  success: true;
  matchedSelector?: { type: string };
  typed?: number;
  filled?: number;
  result?: T;
  found?: boolean;
  key?: string;
  modifiers?: Modifiers;
  selected?: number;
  value?: string | boolean | null;
  redacted?: boolean;
  reason?: string;
  truncated?: boolean;
  originalSize?: number;
}

export interface ContentError {
  error: string;
  errorCode?: string;
  retriable?: boolean;
  recoveryHint?: string;
}

export interface Modifiers {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

// ─── Type Guards ───

export function isHTMLElement(el: unknown): el is HTMLElement {
  return el instanceof HTMLElement;
}

export function isHTMLInputElement(el: unknown): el is HTMLInputElement {
  return el instanceof HTMLInputElement;
}

export function isHTMLSelectElement(el: unknown): el is HTMLSelectElement {
  return el instanceof HTMLSelectElement;
}

export function isHTMLTextAreaElement(el: unknown): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement;
}

export function isHTMLAnchorElement(el: unknown): el is HTMLAnchorElement {
  return el instanceof HTMLAnchorElement;
}

export function isHTMLImageElement(el: unknown): el is HTMLImageElement {
  return el instanceof HTMLImageElement;
}

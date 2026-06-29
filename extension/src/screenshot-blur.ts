/**
 * E5 Screenshot Blur — Detect sensitive elements and temporarily blur them.
 */
import type { ScreenshotBlurConfig, SensitiveFieldType } from "./permissions/config";

const BLUR_CLASS = "brp-screenshot-blur";
const BLUR_STYLE_ID = "brp-screenshot-blur-style";

function injectBlurStyle(): void {
  if (document.getElementById(BLUR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BLUR_STYLE_ID;
  style.textContent = `.${BLUR_CLASS} { filter: blur(8px) !important; transition: filter 0.1s; }`;
  document.head.appendChild(style);
}

export function buildSensitiveSelector(config: ScreenshotBlurConfig): string {
  const parts: string[] = [];
  for (const ft of config.fieldTypes) {
    switch (ft) {
      case "password": parts.push('input[type="password"]'); break;
      case "creditCard": parts.push('input[name*="credit" i]'); parts.push('input[name*="card" i]'); parts.push('input[autocomplete*="cc-" i]'); break;
      case "cvv": parts.push('input[name*="cvv" i]'); parts.push('input[name*="cvc" i]'); break;
      case "email": parts.push('input[type="email"]'); break;
      case "ssn": parts.push('input[name*="ssn" i]'); parts.push('input[name*="social" i]'); break;
    }
  }
  for (const sel of config.customSelectors) { if (sel.trim()) parts.push(sel.trim()); }
  return parts.join(", ");
}

export function findSensitiveElements(config: ScreenshotBlurConfig): HTMLElement[] {
  const selector = buildSensitiveSelector(config);
  if (!selector) return [];
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

export function applyBlur(config: ScreenshotBlurConfig): () => void {
  injectBlurStyle();
  const elements = findSensitiveElements(config);
  for (const el of elements) el.classList.add(BLUR_CLASS);
  return () => { for (const el of elements) el.classList.remove(BLUR_CLASS); };
}

export function shouldBlur(config: ScreenshotBlurConfig): boolean {
  return config.gate !== "never" && (config.fieldTypes.length > 0 || config.customSelectors.length > 0);
}

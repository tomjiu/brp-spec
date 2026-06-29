/**
 * v0.5.1 Page Indicator — Floating status bar on each page.
 *
 * Injected by content.ts. Shows AI control status for the current tab.
 * Auto-fades after 3s, reappears on hover or status change.
 */

const INDICATOR_ID = "brp-page-indicator";
const FADE_DELAY = 3000;

type IndicatorStatus = "active" | "idle" | "hidden";

interface IndicatorState {
  el: HTMLElement;
  fadeTimer: ReturnType<typeof setTimeout> | null;
  hovered: boolean;
}

let state: IndicatorState | null = null;

function getFadeTarget(): string {
  return state?.hovered ? "1" : "0.3";
}

export function createIndicator(): HTMLElement {
  removeIndicator(); // idempotent

  const el = document.createElement("div");
  el.id = INDICATOR_ID;
  el.style.cssText = [
    "position: fixed",
    "top: 12px",
    "right: 12px",
    "z-index: 2147483647",
    "padding: 6px 12px",
    "border-radius: 16px",
    "font-family: system-ui, -apple-system, sans-serif",
    "font-size: 12px",
    "font-weight: 500",
    "color: #fff",
    "box-shadow: 0 2px 8px rgba(0,0,0,0.15)",
    "cursor: pointer",
    "transition: opacity 0.3s, background-color 0.3s",
    "opacity: 1",
    "user-select: none",
    "pointer-events: auto",
  ].join(";");

  document.documentElement.appendChild(el);

  const onEnter = (): void => {
    stopFade();
    el.style.opacity = "1";
  };
  const onLeave = (): void => {
    scheduleFade();
  };

  el.addEventListener("mouseenter", onEnter);
  el.addEventListener("mouseleave", onLeave);
  // store cleanup refs for removeIndicator
  (el as unknown as Record<string, unknown>)["_brpEnter"] = onEnter;
  (el as unknown as Record<string, unknown>)["_brpLeave"] = onLeave;

  state = { el, fadeTimer: null, hovered: false };
  scheduleFade();
  return el;
}

function stopFade(): void {
  if (!state) return;
  state.hovered = true;
  if (state.fadeTimer) {
    clearTimeout(state.fadeTimer);
    state.fadeTimer = null;
  }
}

function scheduleFade(): void {
  if (!state) return;
  state.hovered = false;
  if (state.fadeTimer) clearTimeout(state.fadeTimer);
  state.fadeTimer = setTimeout(() => {
    if (!state || state.hovered) return;
    state.el.style.opacity = getFadeTarget();
  }, FADE_DELAY);
}

export function updateIndicator(status: IndicatorStatus, domain?: string): void {
  if (status === "hidden") {
    removeIndicator();
    return;
  }

  let el = document.getElementById(INDICATOR_ID);
  if (!el) el = createIndicator();
  // createIndicator may have triggered removeIndicator which resets state
  if (!state) {
    state = {
      el,
      fadeTimer: null,
      hovered: false,
    };
  }

  const colors: Record<Exclude<IndicatorStatus, "hidden">, string> = {
    active: "#22c55e", // green
    idle: "#0060df",   // blue
  };

  el.style.backgroundColor = colors[status];
  const icon = status === "active" ? "AI operating" : "Ready";
  const domainPart = domain ? ` · ${domain}` : "";
  el.textContent = `${icon}${domainPart}`;

  // Reset opacity on status change
  stopFade();
  el.style.opacity = "1";
  scheduleFade();
}

export function removeIndicator(): void {
  const el = document.getElementById(INDICATOR_ID);
  if (el) {
    // Remove event listeners
    const onEnter = (el as unknown as Record<string, unknown>)["_brpEnter"] as (() => void) | undefined;
    const onLeave = (el as unknown as Record<string, unknown>)["_brpLeave"] as (() => void) | undefined;
    if (onEnter) el.removeEventListener("mouseenter", onEnter);
    if (onLeave) el.removeEventListener("mouseleave", onLeave);
    el.remove();
  }
  if (state?.fadeTimer) {
    clearTimeout(state.fadeTimer);
  }
  state = null;
}

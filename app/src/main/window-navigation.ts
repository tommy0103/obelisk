// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// URL checks behind the main window's navigation and window-open guards.

export function safeProtocol(url: string): string {
  try { return new URL(url).protocol; } catch { return ''; }
}

export function isSameOrigin(url: string, currentUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(currentUrl).origin;
  } catch {
    return false;
  }
}

// Reloads and in-app routing keep the same origin and pathname; anything else is a real
// navigation away from the renderer document.
export function isSameDocumentNavigation(url: string, currentUrl: string): boolean {
  try {
    const target = new URL(url);
    const current = new URL(currentUrl);
    return target.origin === current.origin && target.pathname === current.pathname;
  } catch {
    return false;
  }
}

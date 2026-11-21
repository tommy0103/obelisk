// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// The recap JSON the skill writes (skill-doc/references/recap). The cards also
// fall back to subtitle, observations, summary, outcome, and stats, so every
// field is optional.

export interface CoverCardData {
  type: 'cover';
  badge?: string;
  title?: string;
  claim?: string;
  subtitle?: string;
  activity?: number[];
  footer?: string;
}

export interface PathItem {
  day?: string;
  prompt?: string;
  turn?: string;
  outcome?: string;
}

export interface PathCardData {
  type: 'thinking_path';
  title?: string;
  items?: PathItem[];
}

export interface VoiceLine {
  label?: string;
  text?: string;
  count?: number;
  time?: string;
}

export interface VibeMeter {
  label?: string;
  value: number;
  caption?: string;
}

export interface VibeQuote {
  text?: string;
  caption?: string;
}

export interface VibeCardData {
  type: 'vibe';
  title?: string;
  voice_lines?: VoiceLine[];
  observations?: VoiceLine[];
  meter?: VibeMeter;
  quote?: VibeQuote;
}

export interface WorkflowItem {
  name?: string;
  reaction?: string;
  outcome?: string;
}

export interface WorkflowCardData {
  type: 'workflow';
  title?: string;
  deck?: string;
  summary?: string;
  stats?: string;
  items?: WorkflowItem[];
  verdict?: string;
}

export interface ClosingCardData {
  type: 'closing';
  headline?: string;
  receipts?: string[];
  stats?: string[];
  most_said_phrase?: string;
  signoff?: string;
}

export interface Recap {
  kind?: string;
  period?: { label?: string; start?: string; end?: string; timezone?: string };
  persona?: { archetype?: string; title?: string; claim?: string; tone?: string };
  cards: [CoverCardData, PathCardData, VibeCardData, WorkflowCardData, ClosingCardData];
}

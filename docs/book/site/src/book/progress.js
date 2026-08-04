// Reading state, persisted to localStorage.
//
// Two things are tracked: which chapters have been read, and which self-check
// questions have been answered correctly. Everything degrades to "nothing
// remembered" if storage is unavailable — the book must still be readable in a
// private window.

import { computed, reactive, watch } from 'vue';

const KEY = 'obelisk-book:progress:v1';

const empty = () => ({ read: {}, quiz: {}, lastSlug: null, lastAt: null });

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw);
    return {
      read: parsed.read && typeof parsed.read === 'object' ? parsed.read : {},
      quiz: parsed.quiz && typeof parsed.quiz === 'object' ? parsed.quiz : {},
      lastSlug: typeof parsed.lastSlug === 'string' ? parsed.lastSlug : null,
      lastAt: typeof parsed.lastAt === 'number' ? parsed.lastAt : null,
    };
  } catch {
    return empty();
  }
}

export const progress = reactive(load());

let saveTimer = null;
watch(
  progress,
  () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(progress));
      } catch {
        // Storage disabled or full; reading state is a convenience, not data.
      }
    }, 200);
  },
  { deep: true },
);

export const markRead = (slug) => {
  progress.read[slug] = true;
};

export const markVisited = (slug) => {
  progress.lastSlug = slug;
  progress.lastAt = Date.now();
};

export const isRead = (slug) => Boolean(progress.read[slug]);

export const recordAnswer = (slug, index, correct) => {
  const key = `${slug}#${index}`;
  if (correct) progress.quiz[key] = true;
};

export const answered = (slug, index) => Boolean(progress.quiz[`${slug}#${index}`]);

export const useProgressSummary = (chapters) =>
  computed(() => {
    const total = chapters.length;
    const read = chapters.filter((c) => progress.read[c.slug]).length;
    return { total, read, pct: total ? Math.round((read / total) * 100) : 0 };
  });

export const resetProgress = () => {
  progress.read = {};
  progress.quiz = {};
  progress.lastSlug = null;
  progress.lastAt = null;
};

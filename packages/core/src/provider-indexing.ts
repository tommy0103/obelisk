import { persist } from './persist.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type {
  Cursor,
  IndexedSession,
  IndexUnit,
  InventoryIssue,
  ProviderAdapter,
} from './providers/types.ts';
import type { SqliteDb } from './sqlite-types.ts';

export interface ProviderSessionProvenance extends IndexedSession {
  readonly source: string;
}

export interface ProviderIndexItem {
  readonly provider: ProviderAdapter;
  readonly unit: IndexUnit;
  readonly cursor: Cursor;
}

export interface ProviderInventoryIssue extends InventoryIssue {
  readonly provider: string;
}

export interface ProviderIndexPlan {
  readonly items: ProviderIndexItem[];
  readonly pendingMarkers: ReadonlyMap<string, string>;
  readonly replayKeys: ReadonlyMap<string, readonly string[]>;
  readonly incompleteProviders: ReadonlySet<string>;
  readonly inventoryIssues: readonly ProviderInventoryIssue[];
}

export interface ProviderIndexResult {
  readonly committed: ProviderIndexItem[];
  readonly failedProviders: ReadonlySet<string>;
  readonly failedItems: ProviderIndexItem[];
  readonly complete: boolean;
  readonly stopped?: { item: ProviderIndexItem; error: unknown };
}

export class ProviderIndexFailure extends Error {
  readonly item: ProviderIndexItem;
  readonly sourceError: unknown;

  constructor(error: unknown, item: ProviderIndexItem) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.item = item;
    this.sourceError = error;
  }
}

export function storedProviderCursor(db: SqliteDb, key: string): Cursor {
  const row = db.prepare('SELECT mtime, lines_processed, cursor FROM index_state WHERE jsonl_path = ?').get(key);
  if (!row) return null;
  return typeof row.cursor === 'string'
    ? row.cursor
    : `${String(row.mtime)}:${String(row.lines_processed)}`;
}

export function readProviderSessionProvenance(db: SqliteDb): ProviderSessionProvenance[] {
  return db.prepare(`
    SELECT id, jsonl_path, COALESCE(source, 'claude') AS source
    FROM sessions
    WHERE jsonl_path IS NOT NULL
      AND jsonl_path != ''
  `).all().map((row) => ({
    source: String(row.source),
    sessionId: String(row.id),
    jsonlPath: String(row.jsonl_path),
  }));
}

export function createProviderIndexPlan(
  db: SqliteDb,
  registry: ProviderRegistry,
  {
    force = false,
    changedPaths,
    priorSessions,
  }: {
    force?: boolean;
    changedPaths?: string[];
    priorSessions?: readonly ProviderSessionProvenance[];
  } = {},
): ProviderIndexPlan {
  const items: ProviderIndexItem[] = [];
  const pendingMarkers = new Map<string, string>();
  const replayKeys = new Map<string, readonly string[]>();
  const incompleteProviders = new Set<string>();
  const inventoryIssues: ProviderInventoryIssue[] = [];
  const provenance = priorSessions ?? readProviderSessionProvenance(db);
  for (const provider of registry.list()) {
    const indexedSessions = provenance
      .filter((session) => session.source === provider.name)
      .map(({ sessionId, jsonlPath }) => ({ sessionId, jsonlPath }));
    const marker = provider.indexVersionMarker;
    const markerMissing = marker !== undefined && !db.prepare(
      'SELECT jsonl_path FROM index_state WHERE jsonl_path = ?',
    ).get(marker);
    const fullReindex = force || (markerMissing && indexedSessions.length > 0);
    if (markerMissing && indexedSessions.length > 0) {
      replayKeys.set(provider.name, [...new Set(indexedSessions.map((session) => session.jsonlPath))]);
    }
    let inventoryComplete = true;
    let reportedIssue: InventoryIssue | undefined;
    const units = provider.discover({
      lastCursor: fullReindex ? () => null : (key) => storedProviderCursor(db, key),
      changedPaths: fullReindex ? undefined : changedPaths,
      indexedSessions: () => indexedSessions,
      reportIncompleteInventory: (issue) => {
        inventoryComplete = false;
        reportedIssue ??= issue;
      },
    });
    if (!inventoryComplete) {
      incompleteProviders.add(provider.name);
      inventoryIssues.push({
        provider: provider.name,
        ...(reportedIssue ?? {
          path: provider.descriptor.defaultRoot,
          error: 'Source inventory is incomplete',
        }),
      });
    }
    if (
      marker !== undefined
      && (force || markerMissing)
      && (inventoryComplete || indexedSessions.length > 0)
    ) {
      pendingMarkers.set(provider.name, marker);
    }
    for (const unit of units) {
      items.push({
        provider,
        unit,
        cursor: fullReindex ? null : storedProviderCursor(db, unit.key),
      });
    }
  }
  return { items, pendingMarkers, replayKeys, incompleteProviders, inventoryIssues };
}

export function indexProviderPlan({
  db,
  plan,
  runTransaction,
  onCommitted = () => {},
  onError,
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  runTransaction: <T>(label: string, work: () => T) => T;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor) => void;
  onError: (error: unknown, item: ProviderIndexItem) => 'skip' | 'stop';
}): ProviderIndexResult {
  const committed: ProviderIndexItem[] = [];
  const failedProviders = new Set<string>();
  const failedItems: ProviderIndexItem[] = [];
  for (const item of plan.items) {
    try {
      const cursor = runTransaction(`provider:${item.provider.name}:${item.unit.key}`, () => (
        persist(db, item.unit, item.provider.parse(item.unit, item.cursor))
      ));
      committed.push(item);
      onCommitted(item, cursor);
    } catch (error) {
      failedProviders.add(item.provider.name);
      failedItems.push(item);
      if (onError(error, item) === 'stop') {
        return {
          committed,
          failedProviders,
          failedItems,
          complete: false,
          stopped: { item, error },
        };
      }
    }
  }
  return {
    committed,
    failedProviders,
    failedItems,
    complete: failedItems.length === 0 && plan.incompleteProviders.size === 0,
  };
}

/** Index every planned unit inside a caller-owned transaction, failing as one snapshot. */
export function indexProviderPlanStrict({
  db,
  plan,
  onCommitted = () => {},
}: {
  db: SqliteDb;
  plan: ProviderIndexPlan;
  onCommitted?: (item: ProviderIndexItem, cursor: Cursor) => void;
}): ProviderIndexResult {
  return indexProviderPlan({
    db,
    plan,
    runTransaction: (_label, work) => work(),
    onCommitted,
    onError: (error, item) => {
      throw new ProviderIndexFailure(error, item);
    },
  });
}

export function writeProviderIndexMarkers(
  db: SqliteDb,
  plan: ProviderIndexPlan,
  result: ProviderIndexResult,
): void {
  if (result.stopped !== undefined) return;
  const retry = db.prepare('DELETE FROM index_state WHERE jsonl_path = ?');
  const write = db.prepare(
    'INSERT OR REPLACE INTO index_state (jsonl_path, mtime, lines_processed) VALUES (?, ?, 0)',
  );
  const committed = new Set(result.committed.map(
    (item) => `${item.provider.name}\0${item.unit.key}`,
  ));
  // A marker records that replay was scheduled. Per-unit cursors record which
  // known sources completed it, so an incomplete inventory retries only the
  // missing or failed sources instead of every readable sibling.
  for (const [provider, keys] of plan.replayKeys) {
    for (const key of keys) {
      if (!committed.has(`${provider}\0${key}`)) retry.run(key);
    }
  }
  for (const item of result.failedItems) {
    if (plan.pendingMarkers.has(item.provider.name)) retry.run(item.unit.key);
  }
  for (const marker of plan.pendingMarkers.values()) {
    write.run(marker, Date.now());
  }
}

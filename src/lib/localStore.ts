import { readCache, writeCache } from "@/lib/cache";
import type { TableRecord } from "@/lib/entries";
import type { TableRow } from "@/lib/tables";

// Per-user, AsyncStorage-backed local mirror of `table` and `table_record`
// rows. This is the read/write surface the app actually uses — mutations
// apply here immediately (instant, works offline) and are queued in the
// outbox below to sync to Supabase in the background.

const LOCAL_TABLES_KEY_PREFIX = "dailytrack:local:tables";
const LOCAL_RECORDS_KEY_PREFIX = "dailytrack:local:records";
const OUTBOX_KEY_PREFIX = "dailytrack:local:outbox";

type TablesById = Record<string, TableRow>;
type RecordsById = Record<string, TableRecord>;

export async function getLocalTables(userId: string): Promise<TablesById> {
  return (await readCache<TablesById>(`${LOCAL_TABLES_KEY_PREFIX}:${userId}`)) ?? {};
}

export async function getLocalTable(userId: string, tableId: string): Promise<TableRow | null> {
  const tables = await getLocalTables(userId);
  return tables[tableId] ?? null;
}

export async function putLocalTable(userId: string, table: TableRow): Promise<void> {
  await putLocalTables(userId, [table]);
}

// Writing many rows must go through a single read-modify-write — calling
// putLocalTable() once per row concurrently (e.g. via Promise.all) is a lost
// update: each call reads the map before any of the others have written
// back, so whichever write finishes last wins and silently drops the rest.
export async function putLocalTables(userId: string, tables: TableRow[]): Promise<void> {
  if (tables.length === 0) return;
  const map = await getLocalTables(userId);
  for (const table of tables) map[table.table_id] = table;
  await writeCache(`${LOCAL_TABLES_KEY_PREFIX}:${userId}`, map);
}

export async function removeLocalTable(userId: string, tableId: string): Promise<void> {
  const tables = await getLocalTables(userId);
  delete tables[tableId];
  await writeCache(`${LOCAL_TABLES_KEY_PREFIX}:${userId}`, tables);
}

export async function getLocalRecords(userId: string): Promise<RecordsById> {
  return (await readCache<RecordsById>(`${LOCAL_RECORDS_KEY_PREFIX}:${userId}`)) ?? {};
}

export async function getLocalRecord(
  userId: string,
  recordId: number
): Promise<TableRecord | null> {
  const records = await getLocalRecords(userId);
  return records[String(recordId)] ?? null;
}

export async function putLocalRecord(userId: string, record: TableRecord): Promise<void> {
  await putLocalRecords(userId, [record]);
}

// See putLocalTables() — same lost-update hazard, same fix: one read, merge
// every row in memory, one write.
export async function putLocalRecords(userId: string, records: TableRecord[]): Promise<void> {
  if (records.length === 0) return;
  const map = await getLocalRecords(userId);
  for (const record of records) map[String(record.record_id)] = record;
  await writeCache(`${LOCAL_RECORDS_KEY_PREFIX}:${userId}`, map);
}

export async function removeLocalRecord(userId: string, recordId: number): Promise<void> {
  await removeLocalRecords(userId, [recordId]);
}

export async function removeLocalRecords(userId: string, recordIds: number[]): Promise<void> {
  if (recordIds.length === 0) return;
  const records = await getLocalRecords(userId);
  for (const recordId of recordIds) delete records[String(recordId)];
  await writeCache(`${LOCAL_RECORDS_KEY_PREFIX}:${userId}`, records);
}

export type OutboxEntity = "table" | "record";

export type OutboxEntry = {
  entity: OutboxEntity;
  entityId: string;
  patch: Record<string, unknown>;
  updatedAt: number;
};

type OutboxByKey = Record<string, OutboxEntry>;

function outboxKey(entity: OutboxEntity, entityId: string): string {
  return `${entity}:${entityId}`;
}

async function getOutboxMap(userId: string): Promise<OutboxByKey> {
  return (await readCache<OutboxByKey>(`${OUTBOX_KEY_PREFIX}:${userId}`)) ?? {};
}

export async function getOutbox(userId: string): Promise<OutboxEntry[]> {
  return Object.values(await getOutboxMap(userId));
}

// Lets the sync-status indicator react to outbox changes made anywhere in
// the app (a mutation queuing a patch, a flush clearing one) without polling.
type OutboxListener = () => void;
const outboxListeners = new Set<OutboxListener>();

export function subscribeOutboxChanges(listener: OutboxListener): () => void {
  outboxListeners.add(listener);
  return () => {
    outboxListeners.delete(listener);
  };
}

function notifyOutboxChanged(): void {
  outboxListeners.forEach((listener) => listener());
}

// Shallow-merges into any already-pending entry for the same row, keeping
// the newest updatedAt — so several offline edits to one row coalesce into
// a single queued push instead of piling up.
export async function queueOutboxPatch(
  userId: string,
  entity: OutboxEntity,
  entityId: string,
  patch: Record<string, unknown>,
  updatedAt: number
): Promise<void> {
  const map = await getOutboxMap(userId);
  const key = outboxKey(entity, entityId);
  const existing = map[key];
  map[key] = {
    entity,
    entityId,
    patch: { ...existing?.patch, ...patch },
    updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt),
  };
  await writeCache(`${OUTBOX_KEY_PREFIX}:${userId}`, map);
  notifyOutboxChanged();
}

export async function removeOutboxEntry(
  userId: string,
  entity: OutboxEntity,
  entityId: string
): Promise<void> {
  await removeOutboxEntries(userId, [{ entity, entityId }]);
}

export async function removeOutboxEntries(
  userId: string,
  keys: { entity: OutboxEntity; entityId: string }[]
): Promise<void> {
  if (keys.length === 0) return;
  const map = await getOutboxMap(userId);
  for (const { entity, entityId } of keys) delete map[outboxKey(entity, entityId)];
  await writeCache(`${OUTBOX_KEY_PREFIX}:${userId}`, map);
  notifyOutboxChanged();
}

import {
  getLocalRecords,
  getLocalTable,
  getOutbox,
  putLocalTable,
  putLocalTables,
  queueOutboxPatch,
  removeLocalRecords,
  removeLocalTable,
  removeOutboxEntries,
} from "@/lib/localStore";
import { supabase } from "@/lib/supabase";
import { flushOutbox } from "@/lib/sync";

export type EntryType = "string" | "numerical" | "duration" | "timestamp";
export type EntryFrequency = "daily" | "aperiodic";

export type TableRow = {
  table_id: string;
  user_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  is_public: boolean | null;
  entry_type: EntryType | null;
  entry_unit: string | null;
  record_frequency: EntryFrequency | null;
  table_name: string | null;
  record_entry_count: number | null;
  record_entry_names: string | null;
  is_incremental: boolean | null;
  table_description: string | null;
};

// record_entry_names is stored as a flat comma-separated string, positionally
// aligned with each entry's index (an empty segment means that entry has no
// custom name yet) — falls back to "Entry N" wherever a name is blank.
export function getEntryLabel(table: TableRow, entryIndex: number): string {
  const names = table.record_entry_names ? table.record_entry_names.split(",") : [];
  const name = names[entryIndex]?.trim();
  return name || `Entry ${entryIndex + 1}`;
}

// A background fetch shouldn't clobber a local edit that hasn't synced yet —
// if there's a pending outbox entry for a row, leave the local copy as-is
// and let the outbox flush resolve it against the server (last-write-wins).
// Batched into a single read-modify-write: writing N rows via N concurrent
// putLocalTable() calls is a lost update (each reads the map before any of
// the others have written back, so the last write wins and drops the rest).
async function reconcileTables(userId: string, serverRows: TableRow[]): Promise<void> {
  const outbox = await getOutbox(userId);
  const pendingIds = new Set(
    outbox.filter((entry) => entry.entity === "table").map((entry) => entry.entityId)
  );
  const toWrite = serverRows.filter((row) => !pendingIds.has(row.table_id));
  await putLocalTables(userId, toWrite);
}

export async function fetchTables(userId: string): Promise<TableRow[]> {
  const { data, error } = await supabase
    .from("table")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  await reconcileTables(userId, data);
  return data;
}

export async function fetchTable(userId: string, tableId: string): Promise<TableRow> {
  const { data, error } = await supabase
    .from("table")
    .select("*")
    .eq("table_id", tableId)
    .single();
  if (error) throw error;
  await reconcileTables(userId, [data]);
  return data;
}

export async function fetchEnumValues(
  enumName: "entry_type" | "entry_frequency"
): Promise<string[]> {
  const { data, error } = await supabase.rpc("get_enum_values", {
    enum_name: enumName,
  });
  if (error) throw error;
  return data ?? [];
}

export type CreateTableInput = {
  table_name: string;
  entry_type: EntryType;
  entry_unit: string | null;
  record_frequency: EntryFrequency;
  record_entry_count: number;
  record_entry_names: string | null;
  is_public: boolean;
  is_incremental: boolean;
  table_description: string | null;
};

// Creating a table always requires connectivity — see the offline-sync plan
// for why (unlike edits, a brand-new row has nothing to reconcile against).
export async function createTable(userId: string, input: CreateTableInput): Promise<TableRow> {
  const now = Date.now();
  const { data, error } = await supabase
    .from("table")
    .insert({
      table_name: input.table_name,
      entry_type: input.entry_type,
      entry_unit: input.entry_unit,
      record_frequency: input.record_frequency,
      record_entry_count: input.record_entry_count,
      record_entry_names: input.record_entry_names,
      is_public: input.is_public,
      is_incremental: input.is_incremental,
      table_description: input.table_description,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();
  if (error) throw error;
  await putLocalTable(userId, data);
  return data;
}

export type UpdateTableInput = {
  table_name?: string;
  table_description?: string | null;
  entry_unit?: string | null;
  record_entry_names?: string | null;
  is_public?: boolean;
};

// Local-first: applies instantly to the local store and queues the change to
// sync in the background, regardless of connectivity.
export async function updateTable(
  userId: string,
  tableId: string,
  patch: UpdateTableInput
): Promise<TableRow> {
  const updatedAt = Date.now();
  const current = (await getLocalTable(userId, tableId)) ?? (await fetchTable(userId, tableId));
  const merged: TableRow = { ...current, ...patch, updated_at: updatedAt };

  await putLocalTable(userId, merged);
  await queueOutboxPatch(userId, "table", tableId, { ...patch, updated_at: updatedAt }, updatedAt);
  flushOutbox(userId).catch(() => {});

  return merged;
}

// Deleting a table always requires connectivity (destructive + rare). On
// success, purge anything queued locally for it so a deleted table doesn't
// leave ghost pending syncs behind.
export async function deleteTable(userId: string, tableId: string): Promise<void> {
  const { error } = await supabase.from("table").delete().eq("table_id", tableId);
  if (error) throw error;

  const localRecords = await getLocalRecords(userId);
  const recordIdsForTable = Object.values(localRecords)
    .filter((record) => record.table_id === tableId)
    .map((record) => record.record_id);

  await removeLocalTable(userId, tableId);
  await removeLocalRecords(userId, recordIdsForTable);
  await removeOutboxEntries(userId, [
    { entity: "table", entityId: tableId },
    ...recordIdsForTable.map((recordId) => ({
      entity: "record" as const,
      entityId: String(recordId),
    })),
  ]);
}

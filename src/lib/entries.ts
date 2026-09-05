import {
  getOutbox,
  putLocalRecord,
  putLocalRecords,
  queueOutboxPatch,
  removeLocalRecord,
  removeOutboxEntry,
} from "@/lib/localStore";
import { supabase } from "@/lib/supabase";
import { flushOutbox } from "@/lib/sync";
import type { TableRow } from "@/lib/tables";

// Terminology: a `table` is logged into over time as a series of `TableRecord`
// rows (daily or aperiodic). Each record holds `record_entry_count` entries —
// the individual data points (a number, a duration, a timestamp, ...) within
// that record.

export type TimerEntryState = {
  running: boolean;
  started_at: number | null;
  base_seconds: number;
};

export type TableRecord = {
  record_id: number;
  table_id: string;
  created_at: number;
  updated_at: number | null;
  record_date: string | null;
  has_data: boolean;
  data: (string | number | null)[];
  timer_state: TimerEntryState[] | null;
};

export function todayDateString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function computeHasData(data: (string | number | null)[]): boolean {
  return data.some((value) => value !== null && value !== "");
}

// A background fetch shouldn't clobber a local edit that hasn't synced yet —
// if there's a pending outbox entry for a row, leave the local copy as-is and
// let the outbox flush resolve it against the server (last-write-wins).
// Batched into a single read-modify-write: writing N rows via N concurrent
// putLocalRecord() calls is a lost update (each reads the map before any of
// the others have written back, so the last write wins and drops the rest).
async function reconcileRecords(userId: string, serverRows: TableRecord[]): Promise<void> {
  const outbox = await getOutbox(userId);
  const pendingIds = new Set(
    outbox.filter((entry) => entry.entity === "record").map((entry) => entry.entityId)
  );
  const toWrite = serverRows.filter((row) => !pendingIds.has(String(row.record_id)));
  await putLocalRecords(userId, toWrite);
}

// Shared by insertRecord() (the real DB write) and draftRecord() (a
// client-only preview of what the next record would look like, used to show
// an already-interactive entry on the Tables screen before any row exists).
// Every new record starts fresh, including duration timers — incremental
// duration only accumulates via start/stop within a single record, it
// doesn't carry a running total across records.
function buildEmptyRecordFields(
  table: TableRow
): { data: (string | number | null)[]; timerState: TimerEntryState[] | null } {
  const count = table.record_entry_count ?? 1;
  const isDuration = table.entry_type === "duration";

  const data: (string | number | null)[] = Array.from(
    { length: count },
    () => (isDuration ? 0 : null)
  );
  const timerState: TimerEntryState[] | null = isDuration
    ? Array.from({ length: count }, () => ({
        running: false,
        started_at: null,
        base_seconds: 0,
      }))
    : null;

  return { data, timerState };
}

// A record-shaped object that doesn't exist in the DB yet (record_id: -1).
// Used to render an interactive entry preview for daily tables before the
// user has entered anything — the real row is only created lazily on the
// first actual mutation (see getOrCreateCurrentRecord).
export function draftRecord(table: TableRow): TableRecord {
  const { data, timerState } = buildEmptyRecordFields(table);
  return {
    record_id: -1,
    table_id: table.table_id,
    created_at: Date.now(),
    updated_at: null,
    record_date: table.record_frequency === "daily" ? todayDateString() : null,
    has_data: false,
    data,
    timer_state: timerState,
  };
}

export async function fetchLatestRecords(
  userId: string,
  tableIds: string[]
): Promise<Map<string, TableRecord>> {
  if (tableIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("table_record")
    .select("*")
    .in("table_id", tableIds)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const rows = data as TableRecord[];
  await reconcileRecords(userId, rows);

  const latest = new Map<string, TableRecord>();
  for (const record of rows) {
    if (!latest.has(record.table_id)) latest.set(record.table_id, record);
  }
  return latest;
}

export async function fetchRecordCounts(tableIds: string[]): Promise<Map<string, number>> {
  if (tableIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("table_record")
    .select("table_id")
    .in("table_id", tableIds)
    .eq("has_data", true);
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data as { table_id: string }[]) {
    counts.set(row.table_id, (counts.get(row.table_id) ?? 0) + 1);
  }
  return counts;
}

export async function fetchRecords(userId: string, tableId: string): Promise<TableRecord[]> {
  const { data, error } = await supabase
    .from("table_record")
    .select("*")
    .eq("table_id", tableId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  await reconcileRecords(userId, data as TableRecord[]);
  return data;
}

export async function fetchRecord(userId: string, recordId: number): Promise<TableRecord> {
  const { data, error } = await supabase
    .from("table_record")
    .select("*")
    .eq("record_id", recordId)
    .single();
  if (error) throw error;
  await reconcileRecords(userId, [data]);
  return data;
}

// Deleting a record always requires connectivity (destructive + rare, same
// as deleteTable). On success, purge anything queued locally for it so a
// deleted record doesn't leave a ghost pending sync behind.
export async function deleteRecord(userId: string, recordId: number): Promise<void> {
  const { error } = await supabase.from("table_record").delete().eq("record_id", recordId);
  if (error) throw error;

  await removeLocalRecord(userId, recordId);
  await removeOutboxEntry(userId, "record", String(recordId));
}

function isServerError(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err;
}

// Creating a record always requires connectivity — see the offline-sync plan
// for why (a brand-new row has no local counterpart to reconcile against,
// and record_id is a DB identity column so we can't assign one client-side).
async function insertRecord(
  userId: string,
  table: TableRow,
  options: { recordDate: string | null }
): Promise<TableRecord> {
  const now = Date.now();
  const { data, timerState } = buildEmptyRecordFields(table);

  try {
    const { data: inserted, error } = await supabase
      .from("table_record")
      .insert({
        table_id: table.table_id,
        created_at: now,
        updated_at: now,
        record_date: options.recordDate,
        has_data: false,
        data,
        timer_state: timerState,
      })
      .select()
      .single();

    if (error) {
      // Two near-simultaneous calls can both try to create "today's" row for
      // a daily table — the partial unique index rejects the loser; fetch
      // and return the winner instead of surfacing a spurious error.
      if (error.code === "23505" && options.recordDate) {
        const { data: existing, error: fetchError } = await supabase
          .from("table_record")
          .select("*")
          .eq("table_id", table.table_id)
          .eq("record_date", options.recordDate)
          .single();
        if (fetchError) throw fetchError;
        await putLocalRecord(userId, existing);
        return existing;
      }
      throw error;
    }
    await putLocalRecord(userId, inserted);
    return inserted;
  } catch (err) {
    if (isServerError(err)) throw err;
    throw new Error("You're offline — connect to the internet to start a new entry.");
  }
}

export async function getOrCreateCurrentRecord(
  userId: string,
  table: TableRow,
  latest: TableRecord | null
): Promise<TableRecord> {
  if (table.record_frequency === "daily") {
    const today = todayDateString();
    if (latest?.record_date === today) return latest;
    return insertRecord(userId, table, { recordDate: today });
  }
  // Aperiodic: the latest existing row stays "current" until the user
  // explicitly creates a new one via createNewRecord().
  if (latest) return latest;
  return insertRecord(userId, table, { recordDate: null });
}

export async function createNewRecord(userId: string, table: TableRow): Promise<TableRecord> {
  const recordDate = table.record_frequency === "daily" ? todayDateString() : null;
  return insertRecord(userId, table, { recordDate });
}

// Local-first: applies instantly to the local store and queues the change to
// sync in the background, regardless of connectivity.
async function saveRecord(
  userId: string,
  record: TableRecord,
  patch: Partial<Pick<TableRecord, "data" | "timer_state" | "has_data">>
): Promise<TableRecord> {
  const updatedAt = Date.now();
  const merged: TableRecord = { ...record, ...patch, updated_at: updatedAt };

  await putLocalRecord(userId, merged);
  await queueOutboxPatch(
    userId,
    "record",
    String(record.record_id),
    { ...patch, updated_at: updatedAt },
    updatedAt
  );
  flushOutbox(userId).catch(() => {});

  return merged;
}

export async function setEntryValue(
  userId: string,
  record: TableRecord,
  entryIndex: number,
  value: string | number | null
): Promise<TableRecord> {
  const data = [...record.data];
  data[entryIndex] = value;
  return saveRecord(userId, record, { data, has_data: computeHasData(data) });
}

export async function incrementEntry(
  userId: string,
  record: TableRecord,
  entryIndex: number,
  delta: number
): Promise<TableRecord> {
  const data = [...record.data];
  const current = typeof data[entryIndex] === "number" ? (data[entryIndex] as number) : 0;
  data[entryIndex] = current + delta;
  return saveRecord(userId, record, { data, has_data: true });
}

export async function toggleTimestampEntry(
  userId: string,
  record: TableRecord,
  entryIndex: number
): Promise<TableRecord> {
  const data = [...record.data];
  data[entryIndex] = data[entryIndex] ? null : Date.now();
  return saveRecord(userId, record, { data, has_data: computeHasData(data) });
}

export async function startTimerEntry(
  userId: string,
  record: TableRecord,
  entryIndex: number
): Promise<TableRecord> {
  const timerState = (record.timer_state ?? []).map((entry) => ({ ...entry }));
  const existing = timerState[entryIndex] ?? {
    running: false,
    started_at: null,
    base_seconds: 0,
  };
  timerState[entryIndex] = {
    running: true,
    started_at: Date.now(),
    base_seconds: existing.base_seconds,
  };
  return saveRecord(userId, record, { timer_state: timerState, has_data: true });
}

export async function stopTimerEntry(
  userId: string,
  record: TableRecord,
  entryIndex: number
): Promise<TableRecord> {
  const timerState = (record.timer_state ?? []).map((entry) => ({ ...entry }));
  const entry = timerState[entryIndex];
  if (!entry?.running || entry.started_at == null) return record;

  const elapsedSeconds = (Date.now() - entry.started_at) / 1000;
  const newBase = entry.base_seconds + elapsedSeconds;
  timerState[entryIndex] = { running: false, started_at: null, base_seconds: newBase };

  const data = [...record.data];
  data[entryIndex] = newBase;

  return saveRecord(userId, record, { timer_state: timerState, data, has_data: true });
}

export async function resetTimerEntry(
  userId: string,
  record: TableRecord,
  entryIndex: number
): Promise<TableRecord> {
  const timerState = (record.timer_state ?? []).map((entry) => ({ ...entry }));
  timerState[entryIndex] = { running: false, started_at: null, base_seconds: 0 };

  const data = [...record.data];
  data[entryIndex] = 0;

  return saveRecord(userId, record, {
    timer_state: timerState,
    data,
    has_data: computeHasData(data),
  });
}

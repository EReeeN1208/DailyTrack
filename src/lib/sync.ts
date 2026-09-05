import NetInfo from "@react-native-community/netinfo";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import {
  getOutbox,
  putLocalRecord,
  putLocalTable,
  removeOutboxEntry,
  subscribeOutboxChanges,
  type OutboxEntry,
} from "@/lib/localStore";
import { supabase } from "@/lib/supabase";

// Resolves one queued edit against whatever's on the server right now, purely
// by comparing `updated_at` — no operation-replay, no merging: whichever
// timestamp is newer wins outright.
async function flushTableEntry(userId: string, entry: OutboxEntry): Promise<void> {
  const { data: serverRow, error: fetchError } = await supabase
    .from("table")
    .select("*")
    .eq("table_id", entry.entityId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  if (!serverRow) {
    // Deleted server-side — nothing left to sync this edit against.
    await removeOutboxEntry(userId, "table", entry.entityId);
    return;
  }

  if (entry.updatedAt >= (serverRow.updated_at ?? 0)) {
    const { data: updated, error: updateError } = await supabase
      .from("table")
      .update({ ...entry.patch, updated_at: entry.updatedAt })
      .eq("table_id", entry.entityId)
      .select()
      .single();
    if (updateError) throw updateError;
    await putLocalTable(userId, updated);
  } else {
    // Server was edited more recently than our offline change — server wins,
    // discard the local patch.
    await putLocalTable(userId, serverRow);
  }
  await removeOutboxEntry(userId, "table", entry.entityId);
}

async function flushRecordEntry(userId: string, entry: OutboxEntry): Promise<void> {
  const recordId = Number(entry.entityId);
  const { data: serverRow, error: fetchError } = await supabase
    .from("table_record")
    .select("*")
    .eq("record_id", recordId)
    .maybeSingle();
  if (fetchError) throw fetchError;

  if (!serverRow) {
    await removeOutboxEntry(userId, "record", entry.entityId);
    return;
  }

  if (entry.updatedAt >= (serverRow.updated_at ?? 0)) {
    const { data: updated, error: updateError } = await supabase
      .from("table_record")
      .update({ ...entry.patch, updated_at: entry.updatedAt })
      .eq("record_id", recordId)
      .select()
      .single();
    if (updateError) throw updateError;
    await putLocalRecord(userId, updated);
  } else {
    await putLocalRecord(userId, serverRow);
  }
  await removeOutboxEntry(userId, "record", entry.entityId);
}

// Only one flush runs at a time (per app session) — a mutation's
// fire-and-forget flush and a screen-focus flush can easily overlap.
let isFlushing = false;

type FlushingListener = (isFlushing: boolean) => void;
const flushingListeners = new Set<FlushingListener>();

function setFlushing(value: boolean): void {
  isFlushing = value;
  flushingListeners.forEach((listener) => listener(value));
}

export async function flushOutbox(userId: string | null | undefined): Promise<void> {
  if (!userId || isFlushing) return;
  setFlushing(true);
  try {
    const entries = await getOutbox(userId);
    for (const entry of entries) {
      try {
        if (entry.entity === "table") {
          await flushTableEntry(userId, entry);
        } else {
          await flushRecordEntry(userId, entry);
        }
      } catch {
        // Offline or some other failure — leave this entry queued and try
        // the rest; it's retried on the next flush trigger.
      }
    }
  } finally {
    setFlushing(false);
  }
}

// Flushes on app foreground. Screens additionally call flushOutbox() from
// their own focus/pull-to-refresh handlers, so a pending edit converges as
// soon as any of those three things happens.
export function useSyncTriggers(userId: string | null | undefined): void {
  useEffect(() => {
    if (!userId) return;
    flushOutbox(userId);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") flushOutbox(userId);
    });
    return () => subscription.remove();
  }, [userId]);
}

export type SyncStatus = "synced" | "syncing" | "offline" | "unsynced";

// Reflects the sync indicator on the Tables screen:
//  - "synced":   nothing queued
//  - "syncing":  a flush is actively running right now
//  - "offline":  something's queued and there's no network to push it with
//  - "unsynced": something's queued, we're online, but it hasn't gone out yet
//                (e.g. a non-connectivity error) — waiting on the next trigger
export function useSyncStatus(userId: string | null | undefined): SyncStatus {
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(isFlushing);
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    if (!userId) return;
    let isMounted = true;

    const refreshPendingCount = () => {
      getOutbox(userId).then((entries) => {
        if (isMounted) setPendingCount(entries.length);
      });
    };
    refreshPendingCount();

    const unsubscribeOutbox = subscribeOutboxChanges(refreshPendingCount);
    flushingListeners.add(setIsSyncing);
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      if (isMounted) setIsOnline(state.isConnected !== false);
    });

    return () => {
      isMounted = false;
      unsubscribeOutbox();
      flushingListeners.delete(setIsSyncing);
      unsubscribeNetInfo();
    };
  }, [userId]);

  if (pendingCount === 0) return "synced";
  if (!isOnline) return "offline";
  if (isSyncing) return "syncing";
  return "unsynced";
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link, Stack, router, useFocusEffect } from "expo-router";

import { useAuth } from "@/context/auth";
import { readCache, writeCache } from "@/lib/cache";
import { fetchLatestRecords, fetchRecordCounts, type TableRecord } from "@/lib/entries";
import { getLocalRecords, getLocalTables } from "@/lib/localStore";
import { flushOutbox, useSyncStatus, useSyncTriggers, type SyncStatus } from "@/lib/sync";
import { fetchTables, type TableRow } from "@/lib/tables";
import { TableCard } from "@/components/table-card";

const RECORD_COUNTS_CACHE_KEY_PREFIX = "dailytrack:cache:record-counts";

type RecordsByTable = Record<string, TableRecord>;
type CountsByTable = Record<string, number>;

function latestPerTable(records: Record<string, TableRecord>): RecordsByTable {
  const latest: RecordsByTable = {};
  for (const record of Object.values(records)) {
    const current = latest[record.table_id];
    if (!current || record.created_at > current.created_at) {
      latest[record.table_id] = record;
    }
  }
  return latest;
}

function sortedTables(tables: Record<string, TableRow>): TableRow[] {
  return Object.values(tables).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

const SYNC_STATUS_META: Record<SyncStatus, { color: string; label: string }> = {
  synced: { color: "#34C759", label: "Synced" },
  syncing: { color: "#FF9500", label: "Syncing…" },
  offline: { color: "#FF9500", label: "No internet" },
  unsynced: { color: "#FF3B30", label: "Unsynced changes" },
};

function SyncIndicator({ status }: { status: SyncStatus }) {
  const meta = SYNC_STATUS_META[status];
  return (
    <View style={styles.syncRow}>
      <View style={[styles.syncDot, { backgroundColor: meta.color }]} />
      <Text style={styles.syncLabel}>{meta.label}</Text>
    </View>
  );
}

export default function Index() {
  const { signOut, session } = useAuth();
  const userId = session?.user.id;
  const recordCountsCacheKey = userId ? `${RECORD_COUNTS_CACHE_KEY_PREFIX}:${userId}` : null;

  useSyncTriggers(userId);
  const syncStatus = useSyncStatus(userId);

  const [tables, setTables] = useState<TableRow[]>([]);
  const [records, setRecords] = useState<RecordsByTable>({});
  const [recordCounts, setRecordCounts] = useState<CountsByTable>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasTablesRef = useRef(false);

  useEffect(() => {
    hasTablesRef.current = tables.length > 0;
  }, [tables.length]);

  // Hydrate instantly from the local store (scoped to this account, so
  // switching users on a shared device never flashes another account's
  // tables) so the list is usable offline before any network round-trip
  // even has a chance to run.
  useEffect(() => {
    if (!userId || !recordCountsCacheKey) return;
    (async () => {
      const [localTables, localRecords, cachedCounts] = await Promise.all([
        getLocalTables(userId),
        getLocalRecords(userId),
        readCache<CountsByTable>(recordCountsCacheKey),
      ]);
      const tableList = sortedTables(localTables);
      if (tableList.length > 0) {
        setTables(tableList);
        setIsLoading(false);
      }
      setRecords(latestPerTable(localRecords));
      if (cachedCounts) setRecordCounts(cachedCounts);
    })();
  }, [userId, recordCountsCacheKey]);

  const load = useCallback(
    async (isRefresh = false) => {
      if (!userId) return;
      if (isRefresh) setIsRefreshing(true);
      // Push any offline edits before pulling, so a reconnect converges in
      // one pass instead of waiting for the next trigger.
      await flushOutbox(userId);
      try {
        const freshTables = await fetchTables(userId);
        const tableIds = freshTables.map((t) => t.table_id);
        const [, counts] = await Promise.all([
          fetchLatestRecords(userId, tableIds),
          fetchRecordCounts(tableIds),
        ]);
        const freshCounts: CountsByTable = {};
        counts.forEach((count, tableId) => {
          freshCounts[tableId] = count;
        });

        // Re-read from the local store rather than trusting the raw server
        // response directly — fetchTables/fetchLatestRecords skip
        // overwriting rows that have an unsynced local edit pending, so the
        // local store (not the server payload) is the correct LWW-resolved
        // view to display.
        const [localTables, localRecords] = await Promise.all([
          getLocalTables(userId),
          getLocalRecords(userId),
        ]);

        setTables(sortedTables(localTables));
        setRecords(latestPerTable(localRecords));
        setRecordCounts(freshCounts);
        setError(null);
        if (recordCountsCacheKey) writeCache(recordCountsCacheKey, freshCounts);
      } catch (err) {
        // Offline or the request failed — keep showing whatever's already on
        // screen (local store or previously fetched) and only surface a
        // hard error when there's genuinely nothing to show.
        if (!hasTablesRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load tables");
        }
      } finally {
        setIsLoading(false);
        if (isRefresh) setIsRefreshing(false);
      }
    },
    [userId, recordCountsCacheKey]
  );

  // Attempted on every app open (screen focus) and on manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const handleRecordMutate = useCallback(
    (tableId: string, record: TableRecord) => {
      // The mutation already wrote through to the local store itself — this
      // just keeps this screen's in-memory view in sync so it renders
      // immediately without an extra AsyncStorage round-trip.
      setRecords((prev) => {
        const previous = prev[tableId];
        const next = { ...prev, [tableId]: record };

        // Bump the count as soon as a record first gets real data (rather
        // than waiting for the next full refresh), so it doesn't lag behind
        // an action the user just took.
        const alreadyCounted =
          !!previous && previous.has_data && previous.record_id === record.record_id;
        if (record.has_data && !alreadyCounted) {
          setRecordCounts((prevCounts) => {
            const nextCounts = { ...prevCounts, [tableId]: (prevCounts[tableId] ?? 0) + 1 };
            if (recordCountsCacheKey) writeCache(recordCountsCacheKey, nextCounts);
            return nextCounts;
          });
        }

        return next;
      });
    },
    [recordCountsCacheKey]
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Tables",
          // Plain custom views in headerLeft/headerRight get wrapped in the
          // automatic iOS 26 "liquid glass" bubble — Stack.Toolbar below
          // renders real native bar buttons instead, which don't. Android
          // doesn't have that bubble, so it keeps the plain JS buttons.
          ...(Platform.OS !== "ios" && {
            headerLeft: () => (
              <Pressable onPress={() => signOut()} hitSlop={8}>
                <Text style={styles.headerButtonText}>Sign out</Text>
              </Pressable>
            ),
            headerRight: () => (
              <Link href="/create-table" asChild>
                <Pressable hitSlop={8}>
                  <Text style={styles.plus}>+</Text>
                </Pressable>
              </Link>
            ),
          }),
        }}
      />
      {Platform.OS === "ios" && (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button variant="plain" tintColor="#208AEF" onPress={() => signOut()}>
              Sign out
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              variant="plain"
              tintColor="#208AEF"
              hidesSharedBackground
              style={styles.toolbarPlus}
              onPress={() => router.push("/create-table")}
            >
              +
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      )}

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={tables}
          keyExtractor={(item) => item.table_id}
          contentContainerStyle={
            tables.length === 0 ? styles.emptyContainer : styles.listContent
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => load(true)}
            />
          }
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No tables yet</Text>
              <Text style={styles.emptySubtext}>
                Tap + to create your first table.
              </Text>
            </View>
          }
          ListFooterComponent={
            <View style={styles.syncFooter}>
              <SyncIndicator status={syncStatus} />
            </View>
          }
          renderItem={({ item }) => (
            <TableCard
              userId={userId!}
              table={item}
              record={records[item.table_id] ?? null}
              recordCount={recordCounts[item.table_id] ?? 0}
              onMutate={handleRecordMutate}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  listContent: { padding: 16, gap: 12 },
  emptyContainer: { flexGrow: 1 },
  emptyText: { fontSize: 17, fontWeight: "600" },
  emptySubtext: { fontSize: 14, color: "#8E8E93" },
  error: { color: "#FF3B30" },
  headerButtonText: { fontSize: 15, color: "#208AEF" },
  plus: { fontSize: 62, lineHeight: 66, color: "#208AEF", fontWeight: "200" },
  toolbarPlus: { fontSize: 38, fontWeight: "200" },
  syncFooter: {
    flexDirection: "row",
    justifyContent: "center",
    paddingTop: 12,
  },
  syncRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: "rgba(120,120,128,0.16)",
  },
  syncDot: { width: 8, height: 8, borderRadius: 4 },
  syncLabel: { fontSize: 12, color: "#8E8E93" },
});

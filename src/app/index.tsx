import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
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
import { fetchTables, type TableRow } from "@/lib/tables";
import { TableCard } from "@/components/table-card";

const TABLES_CACHE_KEY_PREFIX = "dailytrack:cache:tables";
const RECORDS_CACHE_KEY_PREFIX = "dailytrack:cache:latest-records";
const RECORD_COUNTS_CACHE_KEY_PREFIX = "dailytrack:cache:record-counts";

type RecordsByTable = Record<string, TableRecord>;
type CountsByTable = Record<string, number>;

export default function Index() {
  const { signOut, session } = useAuth();
  const userId = session?.user.id;
  const tablesCacheKey = userId ? `${TABLES_CACHE_KEY_PREFIX}:${userId}` : null;
  const recordsCacheKey = userId ? `${RECORDS_CACHE_KEY_PREFIX}:${userId}` : null;
  const recordCountsCacheKey = userId ? `${RECORD_COUNTS_CACHE_KEY_PREFIX}:${userId}` : null;

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

  // Hydrate instantly from the on-device cache (scoped to this account, so
  // switching users on a shared device never flashes another account's
  // cached tables) so the list is usable offline before any network
  // round-trip even has a chance to run.
  useEffect(() => {
    if (!tablesCacheKey || !recordsCacheKey || !recordCountsCacheKey) return;
    (async () => {
      const [cachedTables, cachedRecords, cachedCounts] = await Promise.all([
        readCache<TableRow[]>(tablesCacheKey),
        readCache<RecordsByTable>(recordsCacheKey),
        readCache<CountsByTable>(recordCountsCacheKey),
      ]);
      if (cachedTables && cachedTables.length > 0) {
        setTables(cachedTables);
        setIsLoading(false);
      }
      if (cachedRecords) setRecords(cachedRecords);
      if (cachedCounts) setRecordCounts(cachedCounts);
    })();
  }, [tablesCacheKey, recordsCacheKey, recordCountsCacheKey]);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setIsRefreshing(true);
      try {
        const freshTables = await fetchTables();
        const tableIds = freshTables.map((t) => t.table_id);
        const [latest, counts] = await Promise.all([
          fetchLatestRecords(tableIds),
          fetchRecordCounts(tableIds),
        ]);
        const freshRecords: RecordsByTable = {};
        latest.forEach((record, tableId) => {
          freshRecords[tableId] = record;
        });
        const freshCounts: CountsByTable = {};
        counts.forEach((count, tableId) => {
          freshCounts[tableId] = count;
        });

        setTables(freshTables);
        setRecords(freshRecords);
        setRecordCounts(freshCounts);
        setError(null);
        if (tablesCacheKey) writeCache(tablesCacheKey, freshTables);
        if (recordsCacheKey) writeCache(recordsCacheKey, freshRecords);
        if (recordCountsCacheKey) writeCache(recordCountsCacheKey, freshCounts);
      } catch (err) {
        // Offline or the request failed — keep showing whatever's already on
        // screen (cached or previously fetched) and only surface a hard error
        // when there's genuinely nothing to show.
        if (!hasTablesRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load tables");
        }
      } finally {
        setIsLoading(false);
        if (isRefresh) setIsRefreshing(false);
      }
    },
    [tablesCacheKey, recordsCacheKey, recordCountsCacheKey]
  );

  // Attempted on every app open (screen focus) and on manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const handleRecordMutate = useCallback(
    (tableId: string, record: TableRecord) => {
      setRecords((prev) => {
        const previous = prev[tableId];
        const next = { ...prev, [tableId]: record };
        if (recordsCacheKey) writeCache(recordsCacheKey, next);

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
    [recordsCacheKey, recordCountsCacheKey]
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Tables",
          // Plain custom views in headerLeft/headerRight get wrapped in the
          // automatic iOS 26 "liquid glass" bubble. unstable_header*Items
          // renders native title-style bar buttons instead, which don't.
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
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: "Sign out",
              variant: "plain",
              hidesSharedBackground: true,
              tintColor: "#208AEF",
              onPress: () => signOut(),
            },
          ],
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: "+",
              labelStyle: { fontSize: 38, fontWeight: "300" },
              variant: "plain",
              hidesSharedBackground: true,
              tintColor: "#208AEF",
              onPress: () => router.push("/create-table"),
            },
          ],
        }}
      />

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
          renderItem={({ item }) => (
            <TableCard
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
  plus: { fontSize: 62, lineHeight: 66, color: "#208AEF", fontWeight: "300" },
});

import { Button, Text, View, StyleSheet } from "react-native";

import { useAuth } from "@/context/auth";

export default function Index() {
  const { session, signOut } = useAuth();

  return (
    <View style={styles.container}>
      <Text>Signed in as {session?.user.email}</Text>
      <Button title="Sign out" onPress={() => signOut()} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
});

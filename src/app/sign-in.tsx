import { useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/context/auth";

export default function SignIn() {
  const { signInWithGoogle } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>DailyTrack</Text>
      <Button title="Continue with Google" onPress={handleSignIn} />
      {error && <Text style={styles.error}>{error}</Text>}
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
  title: {
    fontSize: 28,
    fontWeight: "600",
  },
  error: {
    color: "red",
  },
});

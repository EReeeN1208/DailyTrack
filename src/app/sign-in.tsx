import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { useAuth } from "@/context/auth";
import { useTheme } from "@/context/theme";

function GoogleLogo({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <Path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <Path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <Path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </Svg>
  );
}

export default function SignIn() {
  const { signInWithGoogle } = useAuth();
  const { colorScheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isDark = colorScheme === "dark";

  const handleSignIn = async () => {
    setError(null);
    setIsSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: isDark ? "#000000" : "#FFFFFF" }]}>
      <Text style={[styles.title, { color: isDark ? "#FFFFFF" : "#000000" }]}>DailyTrack</Text>

      <Pressable
        onPress={handleSignIn}
        disabled={isSubmitting}
        style={({ pressed }) => [
          styles.googleButton,
          {
            backgroundColor: isDark ? "#1C1C1E" : "#FFFFFF",
            borderColor: isDark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
          },
          pressed && styles.googleButtonPressed,
          isSubmitting && styles.googleButtonDisabled,
        ]}
      >
        <GoogleLogo size={20} />
        <Text style={[styles.googleButtonText, { color: isDark ? "#FFFFFF" : "#1F1F1F" }]}>
          Continue with Google
        </Text>
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
    paddingHorizontal: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: "600",
  },
  googleButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    width: "100%",
    maxWidth: 320,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  googleButtonPressed: { opacity: 0.7 },
  googleButtonDisabled: { opacity: 0.5 },
  googleButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  error: {
    color: "#FF3B30",
    textAlign: "center",
  },
});

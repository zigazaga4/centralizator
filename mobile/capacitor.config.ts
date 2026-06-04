import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor config for the Centralizator document scanner.
 *
 * The API is served over HTTPS (Let's Encrypt on srv1409671.hstgr.cloud),
 * so no cleartext exception is needed. If you ever point the app at a
 * plain-http host for local testing, add `server.cleartext: true` and
 * `android.allowMixedContent: true` temporarily.
 */
const config: CapacitorConfig = {
  appId: "ro.centralizator.scanner",
  appName: "Centralizator Scanner",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;

import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor config for the Centralizator document scanner.
 *
 * `cleartext` + `allowMixedContent` are enabled so the app can reach a
 * plain-http server (e.g. http://76.13.248.144:3600) during early rollout.
 * Once the API sits behind nginx + TLS (https), both can be turned off.
 */
const config: CapacitorConfig = {
  appId: "ro.centralizator.scanner",
  appName: "Centralizator Scanner",
  webDir: "dist",
  server: {
    androidScheme: "https",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;

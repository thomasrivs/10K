import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.thomasrivs.tenk',
  appName: '10K',
  webDir: 'out',
  server: {
    // Load from Vercel deployment — native plugins still work via bridge
    url: 'https://myapp-seven-snowy.vercel.app',
    cleartext: false,
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0a0a0a',
    preferredContentMode: 'mobile',
  },
  plugins: {
    BackgroundGeolocation: {
      // Configured at runtime
    },
  },
};

export default config;

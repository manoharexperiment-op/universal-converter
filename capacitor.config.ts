import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.universalconverter.app',
  appName: 'MunnX Convertor',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
  server: {
    // Allow large WASM files and blob: URLs (needed for ffmpeg.wasm + Tesseract)
    allowNavigation: ['blob:*'],
  },
};

export default config;

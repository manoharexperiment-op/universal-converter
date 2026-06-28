import { registerPlugin } from '@capacitor/core';

export interface SaveToDownloadsOptions {
  /** file:// (or content://) URI of the already-written cache file. */
  sourceUri: string;
  fileName: string;
  mimeType: string;
  /** Optional subfolder under Downloads, e.g. "MunnX Convertor". */
  subDirectory?: string;
}

export interface SaveResult {
  /** content:// URI of the saved file in the Downloads collection. */
  uri: string;
}

export interface DownloadsSaverPlugin {
  /**
   * Android only. Copies the source file into the public Downloads collection
   * via MediaStore (visible in Files, no permission on Android 10+). Rejects
   * with "UNSUPPORTED_VERSION" on Android 9 and below.
   */
  saveToDownloads(options: SaveToDownloadsOptions): Promise<SaveResult>;
}

export const DownloadsSaver = registerPlugin<DownloadsSaverPlugin>('DownloadsSaver');

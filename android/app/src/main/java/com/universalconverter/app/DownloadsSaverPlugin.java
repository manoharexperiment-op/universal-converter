package com.universalconverter.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Saves an already-written cache file into the public Downloads collection via
 * MediaStore, so it shows up in the Files app / Downloads with NO storage
 * permission on Android 10+ (API 29). The bytes are stream-copied from the
 * source file into the MediaStore content:// URI — nothing crosses the JS bridge,
 * so even large (100MB+) files stay memory-flat.
 *
 * On Android 9 and below MediaStore.Downloads does not exist; we reject with
 * "UNSUPPORTED_VERSION" so the JS layer can fall back to the share sheet.
 */
@CapacitorPlugin(name = "DownloadsSaver")
public class DownloadsSaverPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(final PluginCall call) {
        final String sourceUri = call.getString("sourceUri");
        final String fileName = call.getString("fileName");
        final String mimeType = call.getString("mimeType", "application/octet-stream");
        final String subDirectory = call.getString("subDirectory", null);

        if (sourceUri == null || fileName == null) {
            call.reject("sourceUri and fileName are required");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("UNSUPPORTED_VERSION");
            return;
        }

        // Copy off the caller thread so a large (100MB+) file never blocks the UI / ANRs.
        new Thread(() -> doSave(call, sourceUri, fileName, mimeType, subDirectory)).start();
    }

    private void doSave(PluginCall call, String sourceUri, String fileName, String mimeType, String subDirectory) {
        InputStream in = null;
        OutputStream out = null;
        Uri outUri = null;
        ContentResolver resolver = getContext().getContentResolver();
        try {
            in = openInput(sourceUri);

            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            String relPath = Environment.DIRECTORY_DOWNLOADS;
            if (subDirectory != null && !subDirectory.isEmpty()) {
                relPath = relPath + File.separator + subDirectory;
            }
            values.put(MediaStore.Downloads.RELATIVE_PATH, relPath);
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            outUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (outUri == null) {
                call.reject("Could not create a Downloads entry");
                return;
            }

            out = resolver.openOutputStream(outUri);
            if (out == null) {
                call.reject("Could not open the Downloads file for writing");
                return;
            }
            copy(in, out);
            out.flush();
            out.close();
            out = null;

            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(outUri, values, null, null);

            JSObject ret = new JSObject();
            ret.put("uri", outUri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            // Roll back the half-written pending entry so it doesn't linger.
            if (outUri != null) {
                try { resolver.delete(outUri, null, null); } catch (Exception ignored) {}
            }
            call.reject("Save failed: " + e.getMessage(), e);
        } finally {
            closeQuietly(in);
            closeQuietly(out);
        }
    }

    private InputStream openInput(String sourceUri) throws Exception {
        if (sourceUri.startsWith("content://")) {
            return getContext().getContentResolver().openInputStream(Uri.parse(sourceUri));
        }
        String path = sourceUri.startsWith("file://") ? Uri.parse(sourceUri).getPath() : sourceUri;
        return new FileInputStream(new File(path));
    }

    private void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[262144];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
    }

    private void closeQuietly(java.io.Closeable c) {
        if (c != null) {
            try { c.close(); } catch (Exception ignored) {}
        }
    }
}

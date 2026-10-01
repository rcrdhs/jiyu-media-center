package app.jiyu.mediacenter;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Sideload updater. Reads latest-android.yml from the same GitHub Release
 * electron-updater uses, downloads the APK, and hands it to the system installer.
 * Android still requires the user to confirm the install.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
  private static final String RELEASE_DOWNLOAD =
    "https://github.com/rcrdhs/jiyu-media-center/releases/latest/download/";
  private static final String FEED_URL = RELEASE_DOWNLOAD + "latest-android.yml";
  private static final int MAX_REDIRECTS = 5;
  private static final int FEED_MAX_BYTES = 64 * 1024;

  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private final AtomicBoolean downloadRunning = new AtomicBoolean(false);

  @Override
  protected void handleOnDestroy() {
    io.shutdownNow();
    super.handleOnDestroy();
  }

  @PluginMethod
  public void check(PluginCall call) {
    io.execute(() -> {
      try {
        Feed feed = fetchFeed();
        long installed = installedVersionCode();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("updateAvailable", feed.versionCode > installed);
        ret.put("version", feed.version);
        ret.put("versionCode", feed.versionCode);
        ret.put("installedVersionCode", installed);
        call.resolve(ret);
      } catch (Exception err) {
        call.reject(err.getMessage() == null ? "Update check failed" : err.getMessage());
      }
    });
  }

  @PluginMethod
  public void download(PluginCall call) {
    if (!downloadRunning.compareAndSet(false, true)) {
      call.reject("Download already in progress");
      return;
    }
    io.execute(() -> {
      File apk = null;
      try {
        Feed feed = fetchFeed();
        long installed = installedVersionCode();
        if (feed.versionCode <= installed) {
          throw new IOException("Already on the latest version");
        }
        apk = updateFile();
        File parent = apk.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
          throw new IOException("Could not create the update folder");
        }
        if (apk.exists() && !apk.delete()) {
          throw new IOException("Could not replace the previous download");
        }
        downloadApk(feed, apk);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("version", feed.version);
        call.resolve(ret);
      } catch (Exception err) {
        if (apk != null && apk.exists()) apk.delete();
        call.reject(err.getMessage() == null ? "Update download failed" : err.getMessage());
      } finally {
        downloadRunning.set(false);
      }
    });
  }

  @PluginMethod
  public void install(PluginCall call) {
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    File apk = updateFile();
    if (!apk.isFile() || apk.length() < 1) {
      call.reject("Download the update first");
      return;
    }
    activity.runOnUiThread(() -> {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
          && !activity.getPackageManager().canRequestPackageInstalls()) {
          Intent settings = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + activity.getPackageName())
          );
          settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          activity.startActivity(settings);
          JSObject ret = new JSObject();
          ret.put("ok", false);
          ret.put("reason", "permission");
          call.resolve(ret);
          return;
        }
        Uri uri = FileProvider.getUriForFile(
          activity,
          activity.getPackageName() + ".fileprovider",
          apk
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("", uri));
        activity.startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
      } catch (Exception err) {
        call.reject(err.getMessage() == null ? "Could not open the installer" : err.getMessage());
      }
    });
  }

  private File updateFile() {
    File dir = new File(getContext().getFilesDir(), "updates");
    return new File(dir, "jiyu-update.apk");
  }

  private long installedVersionCode() throws Exception {
    PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
    return info.getLongVersionCode();
  }

  private Feed fetchFeed() throws Exception {
    HttpResult result = openFollowingRedirects(new URL(FEED_URL));
    try {
      if (result.code == 404) {
        throw new IOException("No Android update has been published yet");
      }
      if (result.code != 200) {
        throw new IOException("Update feed HTTP " + result.code);
      }
      String text = readString(result.connection.getInputStream(), FEED_MAX_BYTES);
      return Feed.parse(text);
    } finally {
      result.connection.disconnect();
    }
  }

  private void downloadApk(Feed feed, File apk) throws Exception {
    URL url = new URL(RELEASE_DOWNLOAD + feed.path);
    HttpResult result = openFollowingRedirects(url);
    try {
      if (result.code != 200) {
        throw new IOException("Update download HTTP " + result.code);
      }
      long total = result.connection.getContentLengthLong();
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      long written = 0;
      int lastPercent = -1;
      try (InputStream in = result.connection.getInputStream();
           FileOutputStream out = new FileOutputStream(apk)) {
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) >= 0) {
          out.write(buf, 0, n);
          digest.update(buf, 0, n);
          written += n;
          if (total > 0) {
            int percent = (int) Math.min(100, (written * 100L) / total);
            if (percent != lastPercent) {
              lastPercent = percent;
              JSObject event = new JSObject();
              event.put("percent", percent);
              event.put("transferred", written);
              event.put("total", total);
              notifyListeners("progress", event);
            }
          }
        }
      }
      if (total > 0 && written != total) {
        throw new IOException("Update download ended early");
      }
      String got = hex(digest.digest());
      if (!got.equalsIgnoreCase(feed.sha256)) {
        throw new IOException("Downloaded update did not match the published checksum");
      }
    } finally {
      result.connection.disconnect();
    }
  }

  private HttpResult openFollowingRedirects(URL start) throws IOException {
    URL current = start;
    for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!"https".equalsIgnoreCase(current.getProtocol())) {
        throw new IOException("Update download must stay on https");
      }
      HttpURLConnection conn = (HttpURLConnection) current.openConnection();
      conn.setInstanceFollowRedirects(false);
      conn.setConnectTimeout(20_000);
      conn.setReadTimeout(120_000);
      conn.setRequestProperty("User-Agent", "JiyuMedia-Android");
      conn.setRequestProperty("Accept", "*/*");
      int code = conn.getResponseCode();
      if (code >= 300 && code < 400) {
        String location = conn.getHeaderField("Location");
        conn.disconnect();
        if (location == null || location.trim().isEmpty()) {
          throw new IOException("Update redirect was missing a location");
        }
        current = new URL(current, location);
        continue;
      }
      return new HttpResult(conn, code);
    }
    throw new IOException("Update download redirected too many times");
  }

  private static String readString(InputStream in, int max) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[4096];
    int total = 0;
    int n;
    while ((n = in.read(buf)) >= 0) {
      total += n;
      if (total > max) throw new IOException("Update feed is too large");
      out.write(buf, 0, n);
    }
    return out.toString(StandardCharsets.UTF_8);
  }

  private static String hex(byte[] bytes) {
    StringBuilder sb = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      sb.append(Character.forDigit((b >> 4) & 0xF, 16));
      sb.append(Character.forDigit(b & 0xF, 16));
    }
    return sb.toString();
  }

  private static final class HttpResult {
    final HttpURLConnection connection;
    final int code;

    HttpResult(HttpURLConnection connection, int code) {
      this.connection = connection;
      this.code = code;
    }
  }

  private static final class Feed {
    final String version;
    final int versionCode;
    final String path;
    final String sha256;

    Feed(String version, int versionCode, String path, String sha256) {
      this.version = version;
      this.versionCode = versionCode;
      this.path = path;
      this.sha256 = sha256;
    }

    static Feed parse(String text) throws IOException {
      // PowerShell Set-Content -Encoding utf8 writes a UTF-8 BOM; strip it so
      // the first key is "version" not "\uFEFFversion".
      if (text != null && !text.isEmpty() && text.charAt(0) == '\uFEFF') {
        text = text.substring(1);
      }
      String version = "";
      int versionCode = 0;
      String path = "";
      String sha256 = "";
      for (String raw : text.split("\\r?\\n")) {
        String line = raw.trim();
        if (line.isEmpty() || line.startsWith("#")) continue;
        // Also strip BOM if it landed mid-stream somehow.
        if (!line.isEmpty() && line.charAt(0) == '\uFEFF') {
          line = line.substring(1).trim();
        }
        int colon = line.indexOf(':');
        if (colon < 1) continue;
        String key = line.substring(0, colon).trim();
        String value = stripQuotes(line.substring(colon + 1).trim());
        switch (key) {
          case "version" -> version = value;
          case "versionCode" -> versionCode = parseCode(value);
          case "path" -> path = value;
          case "sha256" -> sha256 = value;
          default -> {
            /* ignore extra keys */
          }
        }
      }
      if (version.isEmpty() || versionCode < 1) {
        throw new IOException("Update feed is missing a version");
      }
      if (!path.matches("[A-Za-z0-9._-]{1,180}") || path.contains("..")) {
        throw new IOException("Update feed has an invalid file name");
      }
      if (!sha256.matches("(?i)[a-f0-9]{64}")) {
        throw new IOException("Update feed is missing a checksum");
      }
      return new Feed(version, versionCode, path, sha256);
    }

    private static int parseCode(String value) throws IOException {
      try {
        return Integer.parseInt(value);
      } catch (NumberFormatException err) {
        throw new IOException("Update feed has an invalid version code");
      }
    }

    private static String stripQuotes(String value) {
      if (value.length() >= 2) {
        char first = value.charAt(0);
        char last = value.charAt(value.length() - 1);
        if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
          return value.substring(1, value.length() - 1).trim();
        }
      }
      return value;
    }
  }
}

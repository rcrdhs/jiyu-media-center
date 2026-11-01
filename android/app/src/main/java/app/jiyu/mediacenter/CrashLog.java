package app.jiyu.mediacenter;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Last-crash log for devices we cannot attach adb to (TVs). An uncaught exception
 * on any thread is written to files/crash.log (no tokens: query secrets and long
 * opaque strings are masked), then the platform handler runs as before. On the
 * next launch a dialog shows the summary so it can be photographed / shared, and
 * AppChrome.getCrashLog() returns the full text.
 */
public final class CrashLog {
  private static final String TAG = "JiyuCrash";
  private static final String FILE = "crash.log";
  private static final String PENDING = "crash.pending";
  private static final int MAX_CHARS = 16 * 1024;
  private static volatile boolean installed = false;

  private CrashLog() {}

  public static synchronized void install(Context context) {
    if (installed || context == null) return;
    installed = true;
    final Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
    final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
    Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
      try {
        write(app, thread, error);
      } catch (Throwable ignored) {}
      if (previous != null) {
        previous.uncaughtException(thread, error);
      } else {
        android.os.Process.killProcess(android.os.Process.myPid());
        System.exit(10);
      }
    });
  }

  /** Save a non-fatal but app-breaking event (e.g. WebView renderer gone) so it shows on next start. */
  public static void record(Context context, Throwable error) {
    if (context == null || error == null) return;
    try {
      Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
      write(app, Thread.currentThread(), error);
    } catch (Throwable ignored) {}
  }

  private static void write(Context app, Thread thread, Throwable error) throws Exception {
    StringWriter sw = new StringWriter();
    PrintWriter pw = new PrintWriter(sw);
    pw.println("Jiyu crash " + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(new Date()));
    pw.println("app " + appVersion(app));
    pw.println("device " + Build.MANUFACTURER + " " + Build.MODEL + " (" + Build.DEVICE + ")");
    pw.println("android " + Build.VERSION.RELEASE + " / API " + Build.VERSION.SDK_INT);
    pw.println("abis " + String.join(",", Build.SUPPORTED_ABIS));
    pw.println("tv " + safeIsTv(app));
    pw.println("thread " + (thread != null ? thread.getName() : "?"));
    pw.println();
    error.printStackTrace(pw);
    pw.flush();
    String text = sanitize(sw.toString());
    if (text.length() > MAX_CHARS) text = text.substring(0, MAX_CHARS) + "\n…";
    try (FileOutputStream out = new FileOutputStream(new File(app.getFilesDir(), FILE), false)) {
      out.write(text.getBytes(StandardCharsets.UTF_8));
    }
    new File(app.getFilesDir(), PENDING).createNewFile();
    Log.e(TAG, "saved crash log", error);
  }

  private static String safeIsTv(Context app) {
    try {
      return String.valueOf(TvMode.isTv(app));
    } catch (Throwable t) {
      return "?";
    }
  }

  private static String appVersion(Context app) {
    try {
      PackageInfo pi = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
      long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
      return pi.versionName + " (" + code + ")";
    } catch (Throwable t) {
      return "?";
    }
  }

  /** Mask anything that could be a credential before it touches disk. */
  static String sanitize(String s) {
    if (s == null) return "";
    s = s.replaceAll("(?i)([?&#;](?:[a-z_]*token|key|sig|signature|secret|auth|jwt|pass(?:word)?|session|cookie|code)=)[^&\\s\"']+", "$1***");
    s = s.replaceAll("(?i)(authorization|cookie|bearer)([:= ]+)\\S+", "$1$2***");
    s = s.replaceAll("[A-Za-z0-9_\\-+/=]{40,}", "***");
    return s;
  }

  /** Full text of the last crash, or null. */
  public static String read(Context context) {
    try {
      File f = new File(context.getFilesDir(), FILE);
      if (!f.isFile()) return null;
      byte[] buf = new byte[(int) Math.min(f.length(), MAX_CHARS * 4L)];
      int off = 0;
      try (FileInputStream in = new FileInputStream(f)) {
        int n;
        while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
      }
      return new String(buf, 0, off, StandardCharsets.UTF_8);
    } catch (Throwable t) {
      return null;
    }
  }

  public static void clear(Context context) {
    try {
      new File(context.getFilesDir(), FILE).delete();
      new File(context.getFilesDir(), PENDING).delete();
    } catch (Throwable ignored) {}
  }

  /** After a crash, show a short summary once on the next launch. */
  public static void showPendingIfAny(Activity activity) {
    try {
      File pending = new File(activity.getFilesDir(), PENDING);
      if (!pending.isFile()) return;
      pending.delete();
      String text = read(activity);
      if (text == null || text.isEmpty()) return;
      String[] lines = text.split("\n");
      StringBuilder summary = new StringBuilder();
      int stack = 0;
      for (String line : lines) {
        if (line.startsWith("\tat ")) {
          if (++stack > 6) continue;
        }
        summary.append(line).append('\n');
        if (summary.length() > 1800) break;
      }
      activity.runOnUiThread(() -> {
        try {
          if (activity.isFinishing()) return;
          new AlertDialog.Builder(activity)
            .setTitle("Jiyu closed unexpectedly last time")
            .setMessage("Please send a photo of this screen to the developer.\n\n" + summary)
            .setPositiveButton("OK", (d, w) -> d.dismiss())
            .show();
        } catch (Throwable ignored) {}
      });
    } catch (Throwable ignored) {}
  }
}

package nz.org.kri.gps;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

/** Restart native recording after reboot if a session was active. */
public final class SessionBootRecovery {

    private static final String TAG = "SessionBootRecovery";
    static final String KEY_RECORDING_ACTIVE = "recordingActive";

    private SessionBootRecovery() {}

    public static void markRecordingActive(Context ctx, boolean active) {
        getPrefs(ctx).edit().putBoolean(KEY_RECORDING_ACTIVE, active).apply();
    }

    public static boolean shouldResume(Context ctx) {
        SharedPreferences p = getPrefs(ctx);
        if (!p.getBoolean(KEY_RECORDING_ACTIVE, false)) return false;
        String sessionId = p.getString("sessionId", "");
        String deviceId = p.getString("deviceId", "");
        String ingestUrl = p.getString("ingestUrl", "");
        return !sessionId.isEmpty() && !deviceId.isEmpty() && !ingestUrl.isEmpty();
    }

    public static void resumeIfNeeded(Context ctx, String reason) {
        if (!shouldResume(ctx)) return;
        try {
            Intent intent = new Intent(ctx, CapsizeMonitorService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
            Log.i(TAG, "Resumed native session recorder (" + reason + ")");
        } catch (Exception e) {
            Log.e(TAG, "Failed to resume session recorder", e);
        }
    }

    static SharedPreferences getPrefs(Context ctx) {
        return ctx.getSharedPreferences(CapsizeMonitorService.PREFS, Context.MODE_PRIVATE);
    }
}

package nz.org.kri.gps;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Restart an in-progress recording session after device reboot. */
public class RecordingBootReceiver extends BroadcastReceiver {

    public static final String ACTION_BOOT_RESUME_RETRY = "nz.org.kri.gps.BOOT_RESUME_RETRY";

    private static final String TAG = "SessionRecorder";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (ACTION_BOOT_RESUME_RETRY.equals(action)
                || Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_USER_PRESENT.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            Log.i(TAG, "Boot resume trigger: " + action);
            CapsizeMonitorService.requestBootResume(context.getApplicationContext());
        }
    }
}

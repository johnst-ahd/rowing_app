package nz.org.kri.gps;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** Restart an in-progress recording session after device reboot. */
public class RecordingBootReceiver extends BroadcastReceiver {

    private static final String TAG = "SessionRecorder";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            Log.i(TAG, "Boot completed — checking for active recording session");
            CapsizeMonitorService.startFromBootIfNeeded(context.getApplicationContext());
        }
    }
}

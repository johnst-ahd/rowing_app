package nz.org.rowing.recorder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Resume an in-progress recording session after power-on without opening the app.
 * USER_UNLOCKED covers the common case where prefs are readable after first unlock.
 */
public class SessionBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_USER_UNLOCKED.equals(action)) {
            SessionBootRecovery.resumeIfNeeded(context.getApplicationContext(), action);
        }
    }
}

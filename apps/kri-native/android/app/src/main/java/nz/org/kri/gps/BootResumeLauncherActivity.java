package nz.org.kri.gps;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;

/**
 * Brief foreground trampoline so Android 12+ allows starting the location foreground
 * service after reboot (direct BOOT_COMPLETED starts are often blocked).
 */
public class BootResumeLauncherActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Context app = getApplicationContext();
        if (!CapsizeMonitorService.tryStartBootService(app)) {
            CapsizeMonitorService.scheduleBootResumeRetry(app);
        }
        finish();
        overridePendingTransition(0, 0);
    }
}

package nz.org.kri.gps;

import android.os.Bundle;
import androidx.annotation.NonNull;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CapsizeMonitorPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        CapsizeMonitorService.requestBootResume(getApplicationContext());
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            @NonNull String[] permissions,
            @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        RecordingSetupHelper.onRequestPermissionsResult(this, requestCode, grantResults);
    }
}

package nz.org.kri.gps;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CapsizeMonitorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

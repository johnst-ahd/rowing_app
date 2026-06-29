package nz.org.rowing.coach;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CoachMonitorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

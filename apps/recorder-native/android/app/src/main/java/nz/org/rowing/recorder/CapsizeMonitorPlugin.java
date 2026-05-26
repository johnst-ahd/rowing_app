package nz.org.rowing.recorder;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CapsizeMonitor")
public class CapsizeMonitorPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String deviceId = call.getString("deviceId");
        String ingestUrl = call.getString("ingestUrl");
        if (sessionId == null || deviceId == null || ingestUrl == null) {
            call.reject("sessionId, deviceId, and ingestUrl are required");
            return;
        }
        Intent intent = new Intent(getContext(), CapsizeMonitorService.class);
        intent.putExtra("sessionId", sessionId);
        intent.putExtra("deviceId", deviceId);
        intent.putExtra("ingestUrl", ingestUrl);
        intent.putExtra("ingestToken", call.getString("ingestToken", ""));
        intent.putExtra("athleteId", call.getString("athleteId", ""));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), CapsizeMonitorService.class);
        getContext().stopService(intent);
        call.resolve();
    }

    @PluginMethod
    public void setUpright(PluginCall call) {
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        Double z = call.getDouble("z");
        if (x == null || y == null || z == null) {
            call.reject("x, y, z required");
            return;
        }
        CapsizeMonitorService.setUpright(getContext(), x.floatValue(), y.floatValue(), z.floatValue());
        call.resolve();
    }

}

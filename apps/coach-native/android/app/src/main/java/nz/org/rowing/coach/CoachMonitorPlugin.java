package nz.org.rowing.coach;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CoachMonitor")
public class CoachMonitorPlugin extends Plugin {

    @PluginMethod
    public void startMonitoring(PluginCall call) {
        String apiBaseUrl = call.getString("apiBaseUrl");
        if (apiBaseUrl == null || apiBaseUrl.trim().isEmpty()) {
            call.reject("apiBaseUrl is required");
            return;
        }
        Intent intent = new Intent(getContext(), CoachMonitorService.class);
        intent.putExtra("apiBaseUrl", apiBaseUrl.trim());
        intent.putExtra("ingestToken", call.getString("ingestToken", ""));
        Integer pollMs = call.getInt("pollIntervalMs", 3000);
        intent.putExtra("pollIntervalMs", pollMs != null ? pollMs.longValue() : 3000L);
        getContext()
                .getSharedPreferences(CoachMonitorService.PREFS, android.content.Context.MODE_PRIVATE)
                .edit()
                .putBoolean("monitoringActive", true)
                .apply();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stopMonitoring(PluginCall call) {
        CoachMonitorService.clearMonitoring(getContext());
        Intent intent = new Intent(getContext(), CoachMonitorService.class);
        intent.setAction(CoachMonitorService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        SharedPreferences p =
                getContext().getSharedPreferences(CoachMonitorService.PREFS, android.content.Context.MODE_PRIVATE);
        boolean active = p.getBoolean("monitoringActive", false);
        boolean running = CoachMonitorService.isServiceRunning();
        JSObject ret = new JSObject();
        ret.put("active", active);
        ret.put("serviceRunning", running);
        call.resolve(ret);
    }
}

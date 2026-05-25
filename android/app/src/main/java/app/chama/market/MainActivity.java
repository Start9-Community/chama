package app.chama.market;

import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.Window;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String PREFS_NAME = "chama_native";
    private static final String ASSET_VERSION_KEY = "web_asset_version";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        supportRequestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(5, 5, 10)));
        clearWebViewCacheAfterAppUpdate();
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(5, 5, 10)));
        getWindow().setStatusBarColor(Color.rgb(5, 5, 10));
        getWindow().setNavigationBarColor(Color.rgb(5, 5, 10));
        if (getSupportActionBar() != null) {
            getSupportActionBar().hide();
        }
    }

    private void clearWebViewCacheAfterAppUpdate() {
        String currentVersion = getAppVersionName();
        if (currentVersion == null || currentVersion.isEmpty()) {
            return;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String previousVersion = prefs.getString(ASSET_VERSION_KEY, "");
        if (currentVersion.equals(previousVersion)) {
            return;
        }

        try {
            WebView webView = new WebView(this);
            webView.clearCache(true);
            webView.destroy();
        } catch (Exception ignored) {
            // Best effort: stale web assets should never block app startup.
        }

        prefs.edit().putString(ASSET_VERSION_KEY, currentVersion).apply();
    }

    private String getAppVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName;
        } catch (Exception ignored) {
            return null;
        }
    }
}

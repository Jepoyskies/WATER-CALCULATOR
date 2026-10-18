package ph.watercalc.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * Water Delivery Manager as a real Android app.
 *
 * The whole web app is packaged inside the APK and served to the WebView by
 * AssetSite, so this never needs a network connection - not on the first run,
 * not ever - and everything it stores stays in this app's own private folder,
 * where nothing else on the phone can read it or clear it out.
 */
public class MainActivity extends Activity implements DocumentFlow.Listener {

    private WebView web;
    private DocumentFlow flow;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        getWindow().setStatusBarColor(Color.parseColor("#025AA5"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F4F7F6"));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);   // localStorage: the draft autosave
        settings.setDatabaseEnabled(true);     // IndexedDB: all the real data
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(false);    // respect the app's own viewport tag

        flow = new DocumentFlow(this, this);

        web.setWebViewClient(new AssetSite(this));
        web.setWebChromeClient(flow);
        web.addJavascriptInterface(new NativeBridge(this), NativeBridge.NAME);

        setContentView(web);

        if (saved == null) {
            web.loadUrl(AssetSite.ORIGIN + AssetSite.HOME);
        } else {
            web.restoreState(saved);
        }
    }

    DocumentFlow flow() {
        return flow;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (flow == null || !flow.onActivityResult(requestCode, resultCode, data)) {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        // Let the app's own history win first, so a half-typed sheet is not lost
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** Tells the page how the save went, so it can say so on screen. */
    @Override
    public void onSaveFinished(String status) {
        if (web == null) return;
        web.evaluateJavascript(
                "window.__waterCalcSaveResult && window.__waterCalcSaveResult('"
                        + (status == null ? "failed" : status) + "')",
                null);
    }
}

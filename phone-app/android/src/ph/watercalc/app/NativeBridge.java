package ph.watercalc.app;

import android.webkit.JavascriptInterface;

/**
 * The handle the page reaches for when it needs the app to keep a file.
 *
 * A WebView has no downloader, so the page cannot save anything on its own -
 * a backup, a CSV or a day's summary would just quietly go nowhere. This
 * gives the page a way to ask, and the app answers with the system's own
 * "where do you want to save this" dialog.
 *
 * It is exposed to JavaScript as window.WaterCalcApp. That is only safe
 * because the WebView never leaves the app's own pages: AssetSite hands any
 * outside link to the phone's browser instead of following it, so no page
 * from anywhere else ever gets a look at this.
 */
public class NativeBridge {

    /** What the page finds this under: window.WaterCalcApp */
    static final String NAME = "WaterCalcApp";

    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** Called from the page. Runs on the bridge thread, so it hands off. */
    @JavascriptInterface
    public void saveFile(String filename, String mimeType, String content) {
        DocumentFlow flow = activity.flow();
        if (flow != null && content != null) {
            flow.saveText(filename == null ? "water-backup.json" : filename, mimeType, content);
        }
    }
}

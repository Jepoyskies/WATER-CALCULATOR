package ph.watercalc.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import java.io.OutputStream;

/**
 * The two things a WebView cannot do by itself.
 *
 * 1. When a page has an <input type="file"> on it, a browser opens the file
 *    picker. A WebView does not - it just sits there and nothing happens. The
 *    import half of the backup depends on this, so it is wired up by hand:
 *    the page asks, this opens the picker, and the chosen file is handed back.
 *
 * 2. A browser downloads a file by itself. A WebView has no downloader, so
 *    anything the app wants to hand the user - a backup, a CSV, the day's
 *    summary - would vanish without a word. Instead the page calls
 *    NativeBridge, which lands here, and the user is asked where to put it.
 *    That includes Google Drive and the Downloads folder, so a backup can end
 *    up somewhere a lost phone cannot take with it.
 */
class DocumentFlow extends WebChromeClient {

    /** How the result of a save gets back to the page. */
    interface Listener {
        void onSaveFinished(String status);
    }

    private static final int PICK_FILE = 1001;
    private static final int SAVE_FILE = 1002;

    private final Activity activity;
    private final Listener listener;

    private ValueCallback<Uri[]> pendingPicker;
    private String pendingName;
    private String pendingBody;

    DocumentFlow(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    // ---- the page asked for a file ---------------------------------------

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                     FileChooserParams params) {
        // Only one picker at a time; a second request cancels the first.
        if (pendingPicker != null) pendingPicker.onReceiveValue(null);
        pendingPicker = callback;

        // Deliberately not params.createIntent(). That one narrows the picker
        // to the types listed in the page's accept attribute, and a backup
        // file showing up greyed out and untappable - for no visible reason -
        // is a far worse outcome than the picker listing a few extras.
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");

        try {
            activity.startActivityForResult(intent, PICK_FILE);
            return true;
        } catch (Exception err) {
            pendingPicker = null;
            return false;
        }
    }

    // ---- the page handed over a file to keep ------------------------------

    /** May be called from the JavaScript bridge thread, so hop to the UI one. */
    void saveText(String filename, String mimeType, String body) {
        activity.runOnUiThread(new OpenSaveDialog(this, filename, mimeType, body));
    }

    // Static on purpose. d8 in build-tools 34 crashes on any non-static inner
    // class, so nothing in this app may be one.
    private static class OpenSaveDialog implements Runnable {
        private final DocumentFlow flow;
        private final String name;
        private final String mime;
        private final String body;

        OpenSaveDialog(DocumentFlow flow, String name, String mime, String body) {
            this.flow = flow;
            this.name = name;
            this.mime = mime;
            this.body = body;
        }

        public void run() {
            flow.askWhereToPutIt(name, mime, body);
        }
    }

    private void askWhereToPutIt(String name, String mime, String body) {
        pendingName = name;
        pendingBody = body;

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null || mime.length() == 0 ? "application/octet-stream" : mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);

        try {
            activity.startActivityForResult(intent, SAVE_FILE);
        } catch (Exception err) {
            pendingBody = null;
            listener.onSaveFinished("failed");
        }
    }

    // ---- results ----------------------------------------------------------

    /** MainActivity passes every activity result straight to this. */
    boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE) {
            if (pendingPicker == null) return true;
            Uri[] chosen = null;
            if (resultCode == Activity.RESULT_OK) {
                chosen = FileChooserParams.parseResult(resultCode, data);
            }
            pendingPicker.onReceiveValue(chosen);
            pendingPicker = null;
            return true;
        }

        if (requestCode == SAVE_FILE) {
            Uri target = (resultCode == Activity.RESULT_OK && data != null) ? data.getData() : null;
            if (target == null) {
                pendingBody = null;
                listener.onSaveFinished("cancelled");
                return true;
            }
            write(target);
            return true;
        }

        return false;
    }

    private void write(Uri target) {
        String body = pendingBody;
        pendingBody = null;

        if (body == null) {
            listener.onSaveFinished("cancelled");
            return;
        }

        try {
            OutputStream out = activity.getContentResolver().openOutputStream(target, "wt");
            if (out == null) throw new Exception("could not open the chosen file");
            out.write(body.getBytes("UTF-8"));
            out.flush();
            out.close();
            listener.onSaveFinished("saved");
        } catch (Exception err) {
            listener.onSaveFinished("failed");
        }
    }
}

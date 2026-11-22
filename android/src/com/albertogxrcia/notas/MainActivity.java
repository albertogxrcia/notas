package com.albertogxrcia.notas;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** Envoltorio nativo de Notas: la app web a pantalla completa, con ficheros, cámara y enlaces. */
public class MainActivity extends Activity {
    private static final String HOME = "https://albertogxrcia.github.io/notas/";
    private static final int PICK_FILES = 1;

    private FrameLayout root;
    private WebView web;
    private View offline;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private final Map<String, Transfer> transfers = new ConcurrentHashMap<>();

    private static final class Transfer { Uri uri; OutputStream out; String mime; }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setDecorFitsSystemWindows(false);
        root = new FrameLayout(this);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsets.CONSUMED;
        });
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        offline = buildOfflineView();
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.addJavascriptInterface(new Bridge(), "NotasAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }
        if (saved != null) web.restoreState(saved);
        else web.loadUrl(linkFrom(getIntent()));
    }

    private void goBack() {
        if (web.canGoBack()) web.goBack(); else moveTaskToBack(true);
    }
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { goBack(); }

    private boolean isApp(Uri u) {
        Uri h = Uri.parse(HOME);
        return u != null && h.getScheme().equals(u.getScheme()) && h.getAuthority().equals(u.getAuthority())
            && u.getPath() != null && (u.getPath() + "/").startsWith(h.getPath());
    }
    private String linkFrom(Intent i) {
        Uri d = i == null ? null : i.getData();
        return isApp(d) ? d.toString() : HOME;
    }
    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        if (i.getData() != null && isApp(i.getData())) web.loadUrl(i.getData().toString());
    }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
    @Override protected void onPause() { web.onPause(); CookieManager.getInstance().flush(); super.onPause(); }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onDestroy() {
        for (Transfer t : transfers.values()) abort(t);
        transfers.clear();
        root.removeView(web);
        web.destroy();
        super.onDestroy();
    }

    private View buildOfflineView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(getColor(R.color.fondo));
        TextView t = new TextView(this);
        t.setText("Necesitas conexión para abrir Notas la primera vez");
        t.setGravity(Gravity.CENTER);
        t.setPadding(64, 0, 64, 32);
        Button b = new Button(this);
        b.setText("Reintentar");
        b.setOnClickListener(v -> { offline.setVisibility(View.GONE); web.reload(); });
        box.addView(t);
        box.addView(b, new LinearLayout.LayoutParams(-2, -2));
        return box;
    }

    private final class Client extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            if (isApp(r.getUrl())) return false;
            try { startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); } catch (ActivityNotFoundException ignored) { }
            return true; // lo que no es la app se abre fuera: el puente nativo solo lo ve Notas
        }
        @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame()) offline.setVisibility(View.VISIBLE);
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent content = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) content.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            Intent chooser = Intent.createChooser(content, "Adjuntar");
            Intent camera = cameraIntent();
            if (camera != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { camera });
            try {
                startActivityForResult(chooser, PICK_FILES);
            } catch (ActivityNotFoundException e) {
                finishPick(null);
            }
            return true;
        }
    }

    private Intent cameraIntent() {
        try {
            ContentValues c = new ContentValues();
            c.put(MediaStore.Images.Media.DISPLAY_NAME, "nota-" + System.currentTimeMillis() + ".jpg");
            c.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            c.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Notas");
            cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, c);
            if (cameraUri == null) return null;
            return new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (RuntimeException e) {
            cameraUri = null;
            return null;
        }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != PICK_FILES) return;
        Uri[] out = null;
        boolean usedCamera = false;
        if (res == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                out = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < out.length; i++) out[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) {
                out = new Uri[] { data.getData() };
                usedCamera = data.getData().equals(cameraUri);
            } else if (cameraUri != null) {
                out = new Uri[] { cameraUri };
                usedCamera = true;
            }
        }
        if (!usedCamera && cameraUri != null) {
            try { getContentResolver().delete(cameraUri, null, null); } catch (RuntimeException ignored) { }
        }
        cameraUri = null;
        finishPick(out);
    }
    private void finishPick(Uri[] out) {
        if (fileCallback != null) fileCallback.onReceiveValue(out);
        fileCallback = null;
    }

    private void abort(Transfer t) {
        try { t.out.close(); } catch (IOException ignored) { }
        try { getContentResolver().delete(t.uri, null, null); } catch (RuntimeException ignored) { }
    }
    private void toast(String m) { runOnUiThread(() -> Toast.makeText(this, m, Toast.LENGTH_SHORT).show()); }

    /** Lo que la página puede pedir al sistema. Solo se carga Notas: el resto de enlaces salen fuera. */
    private final class Bridge {
        @JavascriptInterface public void setDark(boolean dark) {
            runOnUiThread(() -> {
                root.setBackgroundColor(dark ? Color.BLACK : Color.rgb(242, 242, 247));
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) c.setSystemBarsAppearance(dark ? 0 : light, light);
            });
        }
        @JavascriptInterface public String begin(String name, String mime) {
            try {
                String safe = name == null ? "fichero" : name.replaceAll("[/\\\\\\p{Cntrl}]", "_");
                ContentValues c = new ContentValues();
                c.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                c.put(MediaStore.Downloads.MIME_TYPE, mime);
                c.put(MediaStore.Downloads.IS_PENDING, 1);
                Transfer t = new Transfer();
                t.mime = mime;
                t.uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c);
                if (t.uri == null) return null;
                t.out = getContentResolver().openOutputStream(t.uri);
                if (t.out == null) { getContentResolver().delete(t.uri, null, null); return null; }
                String id = UUID.randomUUID().toString();
                transfers.put(id, t);
                return id;
            } catch (IOException | RuntimeException e) {
                return null;
            }
        }
        @JavascriptInterface public boolean chunk(String id, String base64) {
            Transfer t = transfers.get(id);
            if (t == null) return false;
            try {
                t.out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (IOException | RuntimeException e) {
                transfers.remove(id);
                abort(t);
                return false;
            }
        }
        @JavascriptInterface public void end(String id, boolean open) {
            Transfer t = transfers.remove(id);
            if (t == null) return;
            try {
                t.out.close();
                ContentValues c = new ContentValues();
                c.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(t.uri, c, null, null);
            } catch (IOException | RuntimeException e) {
                abort(t);
                toast("No se ha podido guardar");
                return;
            }
            if (!open) { toast("Guardado en Descargas"); return; }
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(t.uri, t.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                } catch (ActivityNotFoundException e) {
                    toast("Guardado en Descargas");
                }
            });
        }
    }
}

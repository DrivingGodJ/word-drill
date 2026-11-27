package com.drivinggodj.worddrill

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.Locale

class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {
    private lateinit var webView: WebView
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null

    private val openDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        val callback = fileUploadCallback
        fileUploadCallback = null
        callback?.onReceiveValue(if (uri != null) arrayOf(uri) else emptyArray())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        tts = TextToSpeech(this, this)
        WordbooksStorage.getWordbooksDir(this)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(AndroidBridge(), "_WordDrillAndroid")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                if (url.scheme == "http" || url.scheme == "https") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    return true
                }
                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileUploadCallback?.onReceiveValue(emptyArray())
                fileUploadCallback = filePathCallback
                openDocumentLauncher.launch(arrayOf("application/json", "text/plain", "*/*"))
                return true
            }

            override fun onJsAlert(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message ?: "")
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsConfirm(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message ?: "")
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onJsPrompt(
                view: WebView?,
                url: String?,
                message: String?,
                defaultValue: String?,
                result: JsPromptResult?
            ): Boolean {
                val input = EditText(this@MainActivity).apply { setText(defaultValue ?: "") }
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message ?: "")
                    .setView(input)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result?.confirm(input.text.toString()) }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.__worddrillBack && window.__worddrillBack()") { value ->
                    if (value != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        webView.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val res = tts?.setLanguage(Locale.US)
            tts?.setSpeechRate(0.9f)
            ttsReady = res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED
        }
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }

    private fun openWordbooksFolder(): JSONObject {
        val dir = WordbooksStorage.getWordbooksDir(this)
        val rootUri = DocumentsContract.buildRootUri(
            "com.drivinggodj.worddrill.documents",
            WordDrillDocumentsProvider.ROOT_ID
        )
        val browseIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(rootUri, DocumentsContract.Root.MIME_TYPE_ITEM)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val opened = runCatching {
            startActivity(browseIntent)
            true
        }.getOrElse {
            val extUri = DocumentsContract.buildDocumentUri(
                "com.android.externalstorage.documents",
                "primary:Android/data/$packageName/files/wordbooks"
            )
            runCatching {
                startActivity(Intent(Intent.ACTION_VIEW).apply { setDataAndType(extUri, DocumentsContract.Document.MIME_TYPE_DIR) })
                true
            }.getOrDefault(false)
        }

        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        clipboard?.setPrimaryClip(ClipData.newPlainText("WordDrill Wordbooks Path", dir.absolutePath))

        return JSONObject().apply {
            put("ok", opened)
            put("path", dir.absolutePath)
            if (!opened) put("message", "已复制词库目录路径到剪贴板：${dir.absolutePath}")
        }
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun getWordbooksDir(): String = WordbooksStorage.getWordbooksDir(this@MainActivity).absolutePath

        @JavascriptInterface
        fun openWordbooksDir(): String = openWordbooksFolder().toString()

        @JavascriptInterface
        fun writeWordbookBundle(bookId: String, fileName: String, content: String): String =
            runCatching {
                val path = WordbooksStorage.writeBundle(this@MainActivity, bookId, fileName, content)
                JSONObject().apply { put("ok", true); put("path", path) }.toString()
            }.getOrElse { err ->
                JSONObject().apply { put("ok", false); put("message", err.message ?: "写入失败") }.toString()
            }

        @JavascriptInterface
        fun deleteWordbookBundle(bookId: String): String {
            WordbooksStorage.deleteBundle(this@MainActivity, bookId)
            return JSONObject().apply { put("ok", true) }.toString()
        }

        @JavascriptInterface
        fun listWordbookFiles(): String = WordbooksStorage.listBundlesJson(this@MainActivity)

        @JavascriptInterface
        fun saveExportFile(fileName: String, content: String): String =
            runCatching {
                val path = WordbooksStorage.saveExport(this@MainActivity, fileName, content)
                JSONObject().apply { put("ok", true); put("path", path) }.toString()
            }.getOrElse { err ->
                JSONObject().apply { put("ok", false); put("message", err.message ?: "导出失败") }.toString()
            }

        @JavascriptInterface
        fun getAppInfo(): String {
            val base = runCatching {
                assets.open("web/build-info.json").bufferedReader().use { JSONObject(it.readText()) }
            }.getOrElse { JSONObject() }
            val fallbackVer = runCatching {
                packageManager.getPackageInfo(packageName, 0).versionName
            }.getOrNull() ?: "1.0.0"
            val commit = base.optString("commit", "")
            return JSONObject().apply {
                put("platform", "android")
                put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a")
                put("version", base.optString("version", "").ifBlank { fallbackVer })
                put("commit", commit)
                put("shortCommit", base.optString("shortCommit", "").ifBlank { commit.take(7) })
                put("builtAt", base.optString("builtAt", ""))
            }.toString()
        }

        @JavascriptInterface
        fun speak(text: String): Boolean {
            if (!ttsReady) return false
            val res = tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "wd_${System.currentTimeMillis()}")
            return res == TextToSpeech.SUCCESS
        }
    }
}

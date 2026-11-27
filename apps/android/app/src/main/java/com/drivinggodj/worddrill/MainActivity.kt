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
import java.net.HttpURLConnection
import java.net.URL
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

        private fun httpGetJson(urlStr: String, token: String? = null, useAuthOnApi: Boolean = false): Pair<Int, String> {
            var currentUrl = urlStr
            for (hop in 0 until 6) {
                val url = URL(currentUrl)
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    connectTimeout = 8000
                    readTimeout = 8000
                    requestMethod = "GET"
                    setRequestProperty("User-Agent", "WordDrill-Android")
                    setRequestProperty("Accept", "application/json")
                    if (useAuthOnApi && !token.isNullOrBlank() && url.host == "api.github.com") {
                        setRequestProperty("Authorization", "Bearer ${token.trim()}")
                    }
                }
                val code = conn.responseCode
                if (code in listOf(301, 302, 303, 307, 308)) {
                    val loc = conn.getHeaderField("Location")
                    conn.disconnect()
                    if (loc.isNullOrBlank()) return Pair(code, "")
                    currentUrl = URL(url, loc).toString()
                    continue
                }
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
                return Pair(code, body)
            }
            return Pair(599, "Too many redirects")
        }

        @JavascriptInterface
        fun fetchLatestRelease(token: String?): String {
            val verUrl = "https://github.com/DrivingGodJ/word-drill/releases/download/latest/version.json?t=${System.currentTimeMillis()}"
            var lastErr = ""
            runCatching {
                val (code, body) = httpGetJson(verUrl)
                if (code in 200..299 && body.isNotBlank()) {
                    return JSONObject().apply {
                        put("ok", true)
                        put("data", JSONObject(body))
                    }.toString()
                }
                lastErr = "version.json ($code)"
            }.onFailure {
                lastErr = it.message ?: "network error"
            }

            return runCatching {
                val apiUrl = "https://api.github.com/repos/DrivingGodJ/word-drill/releases/latest"
                val (code, body) = httpGetJson(apiUrl, token, useAuthOnApi = true)
                if (code in 200..299 && body.isNotBlank()) {
                    JSONObject().apply {
                        put("ok", true)
                        put("data", JSONObject(body))
                    }.toString()
                } else {
                    JSONObject().apply {
                        put("ok", false)
                        put("message", "检查更新失败（GitHub $code${if (lastErr.isNotBlank()) " / $lastErr" else ""}）")
                    }.toString()
                }
            }.getOrElse { err ->
                JSONObject().apply {
                    put("ok", false)
                    put("message", "无法连接 GitHub（${err.message ?: lastErr}）")
                }.toString()
            }
        }

        @JavascriptInterface
        fun speak(text: String): Boolean {
            if (!ttsReady) return false
            val res = tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "wd_${System.currentTimeMillis()}")
            return res == TextToSpeech.SUCCESS
        }
    }
}

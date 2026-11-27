package com.drivinggodj.worddrill

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object WordbooksStorage {
    fun getWordbooksDir(context: Context): File {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        return File(base, "wordbooks").apply { if (!exists()) mkdirs() }
    }

    fun getExportsDir(context: Context): File {
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        return File(base, "exports").apply { if (!exists()) mkdirs() }
    }

    fun safeFilename(name: String): String {
        val cleaned = File(name).name
            .replace(Regex("[\\\\/:*?\"<>|]"), "-")
            .trim()
        return if (cleaned.endsWith(".json", ignoreCase = true)) cleaned else "$cleaned.json"
    }

    fun shortBookId(bookId: String): String = bookId.removePrefix("local:")

    fun writeBundle(context: Context, bookId: String, fileName: String, content: String): String {
        val dir = getWordbooksDir(context)
        val targetName = safeFilename(fileName)
        val shortId = shortBookId(bookId)
        if (shortId.isNotEmpty()) {
            val suffix = "__${shortId}.json"
            dir.listFiles()?.forEach { f ->
                if (f.isFile && f.name.endsWith(suffix) && f.name != targetName) {
                    f.delete()
                }
            }
        }
        val target = File(dir, targetName)
        val tmp = File(dir, ".tmp-${System.currentTimeMillis()}.json")
        tmp.writeText(content, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            target.writeText(content, Charsets.UTF_8)
            tmp.delete()
        }
        return target.absolutePath
    }

    fun deleteBundle(context: Context, bookId: String) {
        val dir = getWordbooksDir(context)
        val shortId = shortBookId(bookId)
        if (shortId.isEmpty()) return
        val suffix = "__${shortId}.json"
        dir.listFiles()?.forEach { f ->
            if (f.isFile && f.name.endsWith(suffix)) f.delete()
        }
    }

    fun listBundlesJson(context: Context): String {
        val dir = getWordbooksDir(context)
        val arr = JSONArray()
        dir.listFiles()?.forEach { f ->
            if (f.isFile && f.name.endsWith(".json", ignoreCase = true) && !f.name.startsWith(".")) {
                runCatching {
                    val obj = JSONObject()
                    obj.put("name", f.name)
                    obj.put("content", f.readText(Charsets.UTF_8))
                    arr.put(obj)
                }
            }
        }
        return arr.toString()
    }

    fun saveExport(context: Context, fileName: String, content: String): String {
        val dir = getExportsDir(context)
        val target = File(dir, safeFilename(fileName))
        target.writeText(content, Charsets.UTF_8)
        return target.absolutePath
    }
}

package com.drivinggodj.worddrill

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException

class WordDrillDocumentsProvider : DocumentsProvider() {
    companion object {
        const val ROOT_ID = "wordbooks"
        const val DOC_ROOT = "wordbooks:"
        private val DEFAULT_ROOT_PROJECTION = arrayOf(
            Root.COLUMN_ROOT_ID,
            Root.COLUMN_MIME_TYPES,
            Root.COLUMN_FLAGS,
            Root.COLUMN_ICON,
            Root.COLUMN_TITLE,
            Root.COLUMN_SUMMARY,
            Root.COLUMN_DOCUMENT_ID,
            Root.COLUMN_AVAILABLE_BYTES
        )
        private val DEFAULT_DOC_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
            Document.COLUMN_SIZE
        )
    }

    private fun rootDir(): File = WordbooksStorage.getWordbooksDir(context!!)

    private fun docIdForFile(file: File): String {
        val rootPath = rootDir().canonicalPath
        val filePath = file.canonicalPath
        if (filePath == rootPath) return DOC_ROOT
        val rel = filePath.removePrefix(rootPath).trimStart(File.separatorChar)
        return "$DOC_ROOT$rel"
    }

    private fun fileForDocId(docId: String): File {
        if (docId == DOC_ROOT) return rootDir()
        if (!docId.startsWith(DOC_ROOT)) throw FileNotFoundException("Unknown document $docId")
        val rel = docId.removePrefix(DOC_ROOT)
        val root = rootDir().canonicalFile
        val resolved = File(root, rel).canonicalFile
        if (resolved != root && !resolved.path.startsWith(root.path + File.separator)) {
            throw FileNotFoundException("Invalid document path")
        }
        return resolved
    }

    private fun includeFile(cursor: MatrixCursor, docId: String, file: File) {
        var flags = 0
        val mime = if (file.isDirectory) {
            flags = flags or Document.FLAG_DIR_SUPPORTS_CREATE
            Document.MIME_TYPE_DIR
        } else {
            if (file.canWrite()) {
                flags = flags or Document.FLAG_SUPPORTS_WRITE or
                    Document.FLAG_SUPPORTS_DELETE or
                    Document.FLAG_SUPPORTS_RENAME
            }
            if (file.name.endsWith(".json", ignoreCase = true)) "application/json" else "application/octet-stream"
        }
        cursor.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, docId)
            add(Document.COLUMN_DISPLAY_NAME, if (docId == DOC_ROOT) context?.getString(R.string.wordbooks_root_title) ?: "WordDrill" else file.name)
            add(Document.COLUMN_SIZE, if (file.isFile) file.length() else 0L)
            add(Document.COLUMN_MIME_TYPE, mime)
            add(Document.COLUMN_LAST_MODIFIED, file.lastModified())
            add(Document.COLUMN_FLAGS, flags)
        }
    }

    override fun onCreate(): Boolean = true

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_ROOT_PROJECTION)
        val dir = rootDir()
        cursor.newRow().apply {
            add(Root.COLUMN_ROOT_ID, ROOT_ID)
            add(Root.COLUMN_SUMMARY, dir.absolutePath)
            add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_LOCAL_ONLY)
            add(Root.COLUMN_TITLE, context?.getString(R.string.wordbooks_root_title) ?: "WordDrill 词库")
            add(Root.COLUMN_DOCUMENT_ID, DOC_ROOT)
            add(Root.COLUMN_MIME_TYPES, "application/json\n*/*")
            add(Root.COLUMN_AVAILABLE_BYTES, dir.freeSpace)
            add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
        }
        return cursor
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_DOC_PROJECTION)
        val file = fileForDocId(documentId)
        if (!file.exists()) throw FileNotFoundException("Not found: $documentId")
        includeFile(cursor, documentId, file)
        return cursor
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?
    ): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_DOC_PROJECTION)
        val parent = fileForDocId(parentDocumentId)
        parent.listFiles()?.forEach { child ->
            if (!child.name.startsWith(".")) includeFile(cursor, docIdForFile(child), child)
        }
        return cursor
    }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?
    ): ParcelFileDescriptor {
        val file = fileForDocId(documentId)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
        val parent = fileForDocId(parentDocumentId)
        val safeName = WordbooksStorage.safeFilename(displayName)
        val target = File(parent, safeName)
        if (!target.exists()) target.createNewFile()
        return docIdForFile(target)
    }

    override fun deleteDocument(documentId: String) {
        val file = fileForDocId(documentId)
        if (file == rootDir()) throw FileNotFoundException("Cannot delete root")
        if (!file.delete()) throw FileNotFoundException("Failed to delete $documentId")
    }

    override fun renameDocument(documentId: String, displayName: String): String {
        val src = fileForDocId(documentId)
        val dst = File(src.parentFile, WordbooksStorage.safeFilename(displayName))
        if (!src.renameTo(dst)) throw FileNotFoundException("Failed to rename $documentId")
        return docIdForFile(dst)
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        val parent = fileForDocId(parentDocumentId).canonicalFile
        val child = fileForDocId(documentId).canonicalFile
        return child == parent || child.path.startsWith(parent.path + File.separator)
    }
}

package ru.antispamscream

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import rikka.shizuku.Shizuku
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var status: TextView
    private lateinit var details: TextView
    private lateinit var checkButton: Button

    private val permissionListener = Shizuku.OnRequestPermissionResultListener { _, result ->
        runOnUiThread {
            if (result == 0) runDiagnostics() else status.text = "Доступ Shizuku не предоставлен."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Shizuku.addRequestPermissionResultListener(permissionListener)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 28, 24, 24)
            setBackgroundColor(0xFF101216.toInt())
        }
        val title = TextView(this).apply {
            text = "АНТИСПАМ СКРИМ"
            textSize = 25f
            setTextColor(0xFFFFFFFF.toInt())
            gravity = Gravity.CENTER
        }
        val subtitle = TextView(this).apply {
            text = "Проверка цифрового аудиоканала · HONOR X8b"
            textSize = 14f
            setTextColor(0xFFB8C0CC.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 10, 0, 24)
        }
        status = TextView(this).apply {
            text = "Нажми «Проверить телефон». Приложение проверит системные аудиомаршруты."
            textSize = 16f
            setTextColor(0xFFFFFFFF.toInt())
            setPadding(0, 16, 0, 16)
        }
        checkButton = Button(this).apply {
            text = "ПРОВЕРИТЬ ТЕЛЕФОН"
            setOnClickListener { requestShizukuAndCheck() }
        }
        details = TextView(this).apply {
            textSize = 12f
            setTextColor(0xFFD5D9E0.toInt())
            setPadding(0, 20, 0, 0)
        }
        val warning = TextView(this).apply {
            text = "Важно: эта версия — диагностическая. Она НЕ подмешивает крик в звонок и не меняет звук микрофона. Наличие маршрута в отчёте ещё не доказывает, что прошивка разрешает передачу аудио в линию."
            textSize = 13f
            setTextColor(0xFFFFD28A.toInt())
            setPadding(0, 22, 0, 0)
        }
        root.addView(title, match())
        root.addView(subtitle, match())
        root.addView(status, match())
        root.addView(checkButton, match())
        root.addView(details, match())
        root.addView(warning, match())
        val scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)
    }

    private fun match() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    )

    private fun requestShizukuAndCheck() {
        if (!Shizuku.pingBinder()) {
            status.text = "Shizuku не запущен. Установи Shizuku и запусти его через отладку по Wi‑Fi или ADB."
            return
        }
        when {
            Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED -> runDiagnostics()
            Shizuku.shouldShowRequestPermissionRationale() -> {
                status.text = "Нужно разрешение Shizuku для диагностического чтения системных аудиомаршрутов."
                Shizuku.requestPermission(1001)
            }
            else -> Shizuku.requestPermission(1001)
        }
    }

    private fun runDiagnostics() {
        status.text = "Проверяю системные аудиомаршруты…"
        checkButton.isEnabled = false
        executor.execute {
            val report = try {
                val command = "echo '=== DEVICE ==='; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.display.id; " +
                    "echo '=== AUDIO POLICY MATCHES ==='; dumpsys media.audio_policy 2>&1 | grep -i -E 'telephony|voice.?call|uplink|downlink|in.call|call.?tx|call.?rx' | head -100; " +
                    "echo '=== AUDIO DEVICES ==='; dumpsys audio 2>&1 | grep -i -E 'telephony|voice.?call|uplink|downlink|in.call|call.?tx|call.?rx' | head -100"
                val process = Shizuku.newProcess(arrayOf("sh", "-c", command), null, null)
                val output = BufferedReader(InputStreamReader(process.inputStream)).use { it.readText() }
                val error = BufferedReader(InputStreamReader(process.errorStream)).use { it.readText() }
                process.waitFor()
                output + if (error.isNotBlank()) "\nSTDERR:\n$error" else ""
            } catch (t: Throwable) {
                "Ошибка диагностики: ${t.javaClass.simpleName}: ${t.message}"
            }
            runOnUiThread {
                checkButton.isEnabled = true
                details.text = report.ifBlank { "Система не вернула совпадений по искомым маршрутам." }
                val hasTx = report.contains("TELEPHONY_TX", true) || report.contains("in-call-playback", true) || report.contains("uplink", true)
                status.text = if (hasTx) {
                    "Найдены потенциально интересные аудиомаршруты. Нужна более глубокая проверка передачи."
                } else {
                    "Явные маршруты передачи в телефонную линию не обнаружены. Это ещё не окончательный вердикт."
                }
            }
        }
    }

    override fun onDestroy() {
        Shizuku.removeRequestPermissionResultListener(permissionListener)
        executor.shutdownNow()
        super.onDestroy()
    }
}

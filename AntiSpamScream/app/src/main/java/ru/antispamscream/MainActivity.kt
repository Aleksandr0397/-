package ru.antispamscream

import android.app.Activity
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.PI
import kotlin.math.sin

class MainActivity : Activity() {
    private var track: AudioTrack? = null
    private lateinit var status: TextView
    private lateinit var playButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(24, 28, 24, 24)
            setBackgroundColor(0xFF101216.toInt())
        }
        fun label(text: String, size: Float, color: Int) = TextView(this).apply {
            this.text = text; textSize = size; setTextColor(color); gravity = Gravity.CENTER
        }
        root.addView(label("АНТИСПАМ СКРИМ", 25f, 0xFFFFFFFF.toInt()), match())
        root.addView(label("Два режима передачи звука", 15f, 0xFFB8C0CC.toInt()), match())
        status = label("Выбери режим. Цифровая передача зависит от системных возможностей телефона.", 14f, 0xFFFFFFFF.toInt())
        status.setPadding(0, 24, 0, 24)
        root.addView(status, match())

        val digital = Button(this).apply {
            text = "РЕЖИМ 1 · ЦИФРОВАЯ ПЕРЕДАЧА"
            setOnClickListener {
                status.text = "На HONOR X8b обычное стороннее приложение не имеет публичного API для подачи аудио непосредственно в SIM-звонок. Этот режим пока недоступен без системной поддержки/привилегий. Приложение не будет притворяться, что звук отправлен."
            }
        }
        root.addView(digital, match())

        playButton = Button(this).apply {
            text = "РЕЖИМ 2 · ЧЕРЕЗ ГРОМКОЙ СВЯЗЬ"
            setOnClickListener {
                stopSound()
                status.text = "Включи громкую связь во время разговора, затем нажми кнопку ещё раз. Звук пойдёт из динамика телефона; микрофон может передать его собеседнику. Результат зависит от модели и условий звонка."
                playButton.postDelayed({ playSyntheticScream() }, 250)
            }
        }
        root.addView(playButton, match())

        val stop = Button(this).apply {
            text = "ОСТАНОВИТЬ ЗВУК"
            setOnClickListener { stopSound(); status.text = "Воспроизведение остановлено." }
        }
        root.addView(stop, match())

        val note = label("Важно: звук ограничен штатной громкостью телефона. Не подноси динамик к уху и не используй на максимальной громкости рядом с людьми. Не существует настройки приложения, способной безопасно превысить аппаратный предел.", 13f, 0xFFFFD28A.toInt())
        note.setPadding(0, 24, 0, 0)
        root.addView(note, match())
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun match() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    private fun playSyntheticScream() {
        val sampleRate = 44100
        val seconds = 1.8
        val count = (sampleRate * seconds).toInt()
        val samples = ShortArray(count)
        for (i in 0 until count) {
            val t = i.toDouble() / sampleRate
            val progress = t / seconds
            val envelope = (minOf(1.0, t / 0.08) * minOf(1.0, (seconds - t) / 0.2)).coerceAtLeast(0.0)
            val freq = 650.0 + 520.0 * sin(2.0 * PI * (0.65 * t))
            val phase = 2.0 * PI * freq * t
            val voiceLike = sin(phase) * 0.55 + sin(phase * 2.03) * 0.25 + sin(phase * 3.97) * 0.12
            val rasp = sin(2.0 * PI * (freq * 5.2) * t) * 0.08
            val modulation = 0.72 + 0.28 * sin(2.0 * PI * (7.0 + 2.0 * progress) * t)
            val value = ((voiceLike + rasp) * envelope * modulation * 0.58).coerceIn(-0.85, 0.85)
            samples[i] = (value * Short.MAX_VALUE).toInt().toShort()
        }
        val minBuffer = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val bufferSize = maxOf(minBuffer, samples.size * 2)
        val audio = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track = audio
        audio.write(samples, 0, samples.size)
        audio.play()
        status.text = "Воспроизводится тестовый синтезированный крик через динамик. Это не запись человеческого голоса."
    }

    private fun stopSound() {
        try { track?.stop() } catch (_: Exception) {}
        track?.release()
        track = null
    }

    override fun onDestroy() { stopSound(); super.onDestroy() }
}

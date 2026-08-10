package com.vk7tv.module

import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.util.LruCache
import java.io.File
import java.nio.ByteBuffer
import java.util.Collections
import java.util.concurrent.Executors

/**
 * Картинки эмоутов. Внутри процесса ВК никакого CSP нет, поэтому вся возня
 * с blob:-URL из веб-версии здесь не нужна — качаем напрямую в кэш ВК.
 *
 * В памяти держим байты файла, а Drawable создаём на каждый span свой:
 * у AnimatedImageDrawable один callback, и общий на две видимые ячейки
 * означал бы, что анимируется только последняя.
 */
object EmoteCache {

    // 6 потоков: при открытии пикера сетка просит сотни картинок сразу, и по
    // три штуки они подтягивались заметно долго. Приоритет держим низким —
    // качать эмоуты не должно мешать отрисовке самого ВК.
    private val io = Executors.newFixedThreadPool(6) { r ->
        Thread(r, "vk7tv-img").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }

    // Массовую предзагрузку пака ведём отдельным маленьким пулом, чтобы сотни
    // качающихся картинок набора не забивали очередь перед теми, что прямо
    // сейчас нужны пикеру и чату.
    private val preloadIo = Executors.newFixedThreadPool(2) { r ->
        Thread(r, "vk7tv-preload").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }

    // Какую часть раздела держим свободной. Android считает место «на исходе»
    // при 5 % свободного и тогда вычищает cacheDir приложений — в том числе
    // копию оригинального APK, из которой запускается пропатченный клиент
    // (см. LsPatch). Сами картинки лежат в filesDir и от этой чистки не
    // страдают, но занятым местом подводят раздел к её границе, поэтому
    // оставляем вдвое больший запас.
    private const val FREE_RESERVE_PART = 10

    // Ниже этого потолок не опускаем даже на забитом телефоне: иначе картинки
    // вытесняются быстрее, чем успевают пригодиться. Совпадает с нижней
    // границей значения в настройках.
    private const val MIN_CAP_BYTES = 64L * 1024 * 1024

    /**
     * Потолок кэша картинок: настроенный (Config.cacheCapMb), но не такой,
     * чтобы после нас на разделе осталось меньше [FREE_RESERVE_PART]-й части.
     * Считаем каждый раз: свободное место меняется и без нас.
     *
     * Картинки лежат в постоянной папке (filesDir) — переживают офлайн и
     * очистку кэша ВК. Как вышли за потолок — вытесняем давно не тронутые
     * файлы (LRU по времени файла) до 80 % потолка.
     */
    private fun capBytes(): Long {
        val configured = Config.cacheCapMb.toLong() * 1024 * 1024
        val room = L.safe("свободное место") {
            val st = android.os.StatFs(dir.path)
            val free = st.availableBlocksLong * st.blockSizeLong
            val reserve = st.blockCountLong * st.blockSizeLong / FREE_RESERVE_PART
            // сколько можем занимать: то, что уже заняли, плюс свободное,
            // минус запас, который обязаны оставить
            maxOf(diskBytes, 0L) + free - reserve
        } ?: configured
        return minOf(configured, room).coerceAtLeast(MIN_CAP_BYTES)
    }

    private val diskLock = Any()

    @Volatile
    private var diskBytes = -1L // -1 = ещё не посчитано

    private lateinit var dir: File

    private val bytes = object : LruCache<String, ByteArray>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }

    // url-ключ -> все, кто ждёт эту картинку. Раньше тут был просто Set, и
    // колбэк на готовность регистрировал ТОЛЬКО первый, кто попросил url:
    // если тот же эмоут одновременно просили чат и пикер (или несколько
    // ячеек), будили одного, а остальные висели текстом/пустой ячейкой до
    // перезахода. Теперь будим всех, кто ждал.
    private val waiters = HashMap<String, MutableList<() -> Unit>>()
    private val failed = Collections.synchronizedSet(HashSet<String>())

    fun init(cacheDir: File) {
        dir = File(cacheDir, "img").apply { mkdirs() }
        // обрывки прошлых записей (.tmp) — если запись оборвалась крэшем или
        // выключением; настоящие файлы их не читают, но копить незачем
        L.safe("уборка tmp") {
            dir.listFiles { f -> f.name.endsWith(TMP) }?.forEach { it.delete() }
        }
    }

    /**
     * Готовый Drawable или null. Если картинки ещё нет — ставит её в очередь
     * и дёргает [onReady] после загрузки. Слово до этого момента остаётся
     * текстом: лучше показать код, чем дырку в сообщении.
     */
    fun drawable(url: String, onReady: () -> Unit): Drawable? {
        val key = keyOf(url)
        bytes.get(key)?.let { return decode(it) }
        if (failed.contains(key)) return null

        val onDisk = File(dir, key)
        if (onDisk.isFile) {
            val data = L.safe("чтение $key") { onDisk.readBytes() }
            if (data != null && isDecodable(data)) {
                // LRU дискового кэша: освежаем время файла, чтобы часто нужные
                // картинки не вытеснялись первыми при подрезке
                L.safe("освежить $key") { onDisk.setLastModified(System.currentTimeMillis()) }
                bytes.put(key, data)
                return decode(data)
            }
            // Битый/обрезанный файл — источник молчаливого нативного вылета
            // (ImageDecoder на таком не бросает исключение, а роняет процесс).
            // Сносим и качаем заново — проваливаемся ниже к постановке в очередь.
            L.i("битый файл кэша, пересоздаю: $key")
            L.safe("удаление битой картинки") { onDisk.delete() }
        }

        // становимся в очередь ожидающих; качает только тот, кто пришёл первым
        val first = synchronized(waiters) {
            val list = waiters.getOrPut(key) { ArrayList(2) }
            val wasEmpty = list.isEmpty()
            list.add(onReady)
            wasEmpty
        }
        if (first) {
            io.execute {
                try {
                    val data = Net.bytes(url)
                    if (!isDecodable(data)) {
                        // мусор вместо картинки (заглушка провайдера, обрезок) —
                        // в кэш не пускаем, иначе потом уронит нативный декодер
                        failed.add(key)
                        synchronized(waiters) { waiters.remove(key) }
                        L.v("битые данные картинки, не кэширую $url")
                        return@execute
                    }
                    writeAtomic(key, data)
                    bytes.put(key, data)
                    accountAndTrim(data.size)
                    wake(key)
                } catch (t: Throwable) {
                    failed.add(key)
                    // будить не надо: повторный рендер упрётся в failed и
                    // честно оставит текст, а список ожидающих просто сбрасываем
                    synchronized(waiters) { waiters.remove(key) }
                    L.v("не скачалось $url: $t")
                }
            }
        }
        return null
    }

    /**
     * Заранее скачать картинки набора, чтобы пак был виден офлайн: один раз с
     * VPN — дальше без сети. Уже лежащие пропускаем; в память не кладём, чтобы
     * предзагрузка не вытесняла горячие картинки из LruCache.
     */
    // Сколько картинок тянем за один заход. У человека с 58 наборами эмоутов
    // 43 тысячи: раньше на каждую заводилась своя задача, и очередь из 43 тысяч
    // задач вместе с проверкой файлов на месте вызова съедала клиент. Остальное
    // догрузится при следующей перезагрузке наборов или само, когда встретится
    // в чате.
    private const val PRELOAD_MAX = 1500

    @Volatile
    private var preloading = false

    /**
     * Дотянуть картинки в постоянный кэш, чтобы наборы были видны офлайн.
     * Весь обход идёт одной фоновой задачей: тысячи проверок «файл уже есть»
     * — это тысячи обращений к диску, и на UI-потоке им делать нечего.
     */
    fun preload(urls: Collection<String>) {
        if (preloading) return // прошлый заход ещё идёт
        preloading = true
        preloadIo.execute {
            L.safe("предзагрузка") {
                var done = 0
                var skipped = 0
                for (url in urls) {
                    if (done >= PRELOAD_MAX) {
                        skipped++
                        continue
                    }
                    val key = keyOf(url)
                    if (bytes.get(key) != null || File(dir, key).isFile) continue
                    L.safe("предзагрузка $key") {
                        val data = Net.bytes(url)
                        if (!isDecodable(data)) {
                            L.v("битые данные при предзагрузке $url")
                            return@safe
                        }
                        writeAtomic(key, data)
                        accountAndTrim(data.size)
                        wake(key) // вдруг эту картинку уже кто-то ждёт на экране
                        done++
                    }
                }
                if (skipped > 0) L.i("предзагрузка: взяли $done, отложили $skipped")
            }
            preloading = false
        }
    }

    /** Учли новый файл; вышли за потолок — подрезали давние. */
    private fun accountAndTrim(added: Int) {
        ensureAccounted()
        synchronized(diskLock) { diskBytes += added }
        trimDisk()
    }

    /** Разовый подсчёт занятого на диске — лениво, вне UI-потока. */
    private fun ensureAccounted() {
        if (diskBytes >= 0) return
        synchronized(diskLock) {
            if (diskBytes >= 0) return
            var sum = 0L
            dir.listFiles()?.forEach { sum += it.length() }
            diskBytes = sum
        }
    }

    /**
     * Вытесняем, пока не уложимся в 80 % потолка. Сначала удаляем картинки не из
     * подключённых наборов — превью чужих эмоутов: они нужны разово, для одного
     * сообщения. Свои удаляем в последнюю очередь: без них пустеет пикер и пак
     * перестаёт открываться офлайн. Внутри каждой группы — по давности.
     */
    private fun trimDisk() {
        val cap = capBytes()
        if (diskBytes <= cap) return
        synchronized(diskLock) {
            if (diskBytes <= cap) return
            // от уже посчитанного потолка: свободное место читается системным
            // вызовом, и второй раз спрашивать его незачем
            val target = cap * 4 / 5
            val files = dir.listFiles() ?: return
            val own = ownKeys()
            // время и «своё ли» считаем по разу на файл: в компараторе это были
            // бы тысячи лишних обращений к файловой системе
            val order = files.map { Row(it, it.lastModified(), own.contains(it.name)) }
                .sortedWith(compareBy({ it.own }, { it.mtime })) // сначала чужие, внутри — давние
            var i = 0
            while (diskBytes > target && i < order.size) {
                val f = order[i].file; i++
                val len = f.length()
                if (L.safe("удаление картинки") { f.delete() } == true) diskBytes -= len
            }
            L.i("кэш картинок подрезан до ${diskBytes / (1024 * 1024)} МБ")
        }
    }

    private class Row(val file: File, val mtime: Long, val own: Boolean)

    /**
     * Имена файлов картинок из подключённых наборов. Считаем по текущим наборам,
     * а не помечаем файлы при скачивании: приоритет меняется сам при
     * подключении и отключении набора, чинить пометки не надо.
     */
    private fun ownKeys(): Set<String> {
        if (!Emotes.ready) return emptySet() // наборы ещё не поднялись — судить не по чему
        return L.safe("список своих картинок") {
            Emotes.allUrls().mapTo(HashSet()) { keyOf(it) }
        } ?: emptySet()
    }

    /**
     * Применить потолок кэша после смены его в настройках: если уменьшили —
     * лишнее подрежется сразу, не дожидаясь новых загрузок. Дисковый ввод-вывод,
     * звать только вне UI-потока.
     */
    fun enforceCap() {
        ensureAccounted()
        trimDisk()
    }

    /**
     * Полный объём раздела, где лежит кэш, в МБ — верхняя граница для «своего»
     * размера кэша в настройках. Если посчитать не вышло — щедрый запас, чтобы
     * поле ввода не блокировало разумные значения.
     */
    fun deviceTotalMb(): Long =
        L.safe("объём хранилища") {
            val st = android.os.StatFs(dir.path)
            st.blockCountLong * st.blockSizeLong / (1024L * 1024L)
        } ?: 8192L

    /** Сколько сейчас занято кэшем картинок на диске, байт. Считать вне UI. */
    fun usageBytes(): Long {
        var sum = 0L
        L.safe("размер кэша") { dir.listFiles()?.forEach { sum += it.length() } }
        return sum
    }

    /**
     * Стереть все скачанные картинки (кнопка «очистить» в настройках).
     * Наборы не трогаем — картинки до-качаются при показе. Возвращает,
     * сколько байт освободили.
     */
    fun clear(): Long {
        synchronized(diskLock) {
            var freed = 0L
            L.safe("очистка кэша") {
                dir.listFiles()?.forEach { f ->
                    val len = f.length()
                    if (f.delete()) freed += len
                }
            }
            diskBytes = 0
            bytes.evictAll()
            failed.clear()
            return freed
        }
    }

    /** Картинка готова — будим всех, кто её ждал, и очищаем очередь. */
    private fun wake(key: String) {
        val list = synchronized(waiters) { waiters.remove(key) } ?: return
        for (cb in list) L.safe("колбэк картинки") { cb() }
    }

    private fun decode(data: ByteArray): Drawable? = L.safe("декод картинки") {
        // Единственное место, где модуль может умереть молча: ImageDecoder на
        // битых данных роняет процесс, поймать нечем. Отсюда и взводится
        // счётчик запуска — до вызова, а не после.
        Startup.arm()
        val src = ImageDecoder.createSource(ByteBuffer.wrap(data))
        val d = ImageDecoder.decodeDrawable(src) { dec, _, _ ->
            dec.isMutableRequired = false
            dec.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        // анимированные webp с 7TV система тянет сама, свой декодер не нужен
        (d as? AnimatedImageDrawable)?.repeatCount = AnimatedImageDrawable.REPEAT_INFINITE
        d
    }

    private const val TMP = ".tmp"

    /**
     * Пишем через .tmp + rename. Оборванная запись (крэш, выключение телефона)
     * не оставит обрезанный файл под настоящим именем — а именно такой файл
     * потом роняет нативный декодер. rename в пределах одной папки атомарен.
     */
    private fun writeAtomic(key: String, data: ByteArray) {
        val tmp = File(dir, key + TMP)
        tmp.writeBytes(data)
        if (!tmp.renameTo(File(dir, key))) {
            // редкий путь: не переименовалось — на диск не кладём, но в памяти
            // картинка уже есть (данные проверены), эту сессию покажем и так
            L.safe("удаление tmp") { tmp.delete() }
        }
    }

    /**
     * Похоже ли на целую картинку. Нативный ImageDecoder на битых/обрезанных
     * данных не бросает исключение, а роняет ВЕСЬ процесс (SIGSEGV) — поймать
     * нечем, поэтому в декодер пускаем только то, что прошло эту проверку.
     * Сверяем сигнатуру, а для webp (формат 7TV) — ещё и что файл не обрезан:
     * в заголовке RIFF записан его размер.
     */
    private fun isDecodable(data: ByteArray): Boolean {
        if (data.size < 16) return false
        fun b(i: Int) = data[i].toInt() and 0xff
        // RIFF ???? WEBP
        if (b(0) == 0x52 && b(1) == 0x49 && b(2) == 0x46 && b(3) == 0x46 &&
            b(8) == 0x57 && b(9) == 0x45 && b(10) == 0x42 && b(11) == 0x50
        ) {
            val declared = b(4).toLong() or (b(5).toLong() shl 8) or
                (b(6).toLong() shl 16) or (b(7).toLong() shl 24)
            // обрезан, если данных меньше заявленного; длиннее — не беда
            return data.size.toLong() >= declared + 8
        }
        // PNG \x89PNG
        if (b(0) == 0x89 && b(1) == 0x50 && b(2) == 0x4E && b(3) == 0x47) return true
        // GIF8
        if (b(0) == 0x47 && b(1) == 0x49 && b(2) == 0x46 && b(3) == 0x38) return true
        // JPEG FF D8 FF
        if (b(0) == 0xFF && b(1) == 0xD8 && b(2) == 0xFF) return true
        return false
    }

    private fun keyOf(url: String): String =
        url.substringAfter("/emote/", url).replace('/', '_').ifEmpty { url.hashCode().toString() }
}

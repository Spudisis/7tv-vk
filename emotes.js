// VK7TV — общая сборка эмоутов из хранилища.
//
// Одно и то же — чтение настроек, приведение значений к одному виду, порядок
// разделов и правила коллизий кодов — раньше было написано трижды: в
// контент-скрипте, в пикере и в попапе. Расхождения между копиями стоили
// бага, при котором попап показывал эмоуты, а поповер на странице оставался
// пустым: на битой записи в кэше одна копия падала, другая нет. Теперь
// хранилище читается здесь, а каждая сторона строит из разделов своё
// представление: пикер — сетку по разделам, чат и попап — плоскую карту имён.
//
// Подключается перед content.js и в попапе, после default-emotes.js.

const VK7TV = (() => {
  // старый кэш и часть своих эмоутов хранят просто строку-URL
  const normEmote = (v) => (typeof v === 'string' ? { u: v, z: 0 } : v);

  const usable = (em) => !!(em && typeof em.u === 'string' && em.u);

  // Негодные записи отбрасываем здесь, один раз: раньше исключение на такой
  // записи обрывало сборку целиком — в чате не подменялось ничего, а в
  // поповере оставались заголовки наборов без единого эмоута.
  function cleanEmotes(map) {
    const out = {};
    if (!map || typeof map !== 'object') return out;
    for (const [name, v] of Object.entries(map)) {
      const em = normEmote(v);
      if (usable(em)) out[name] = em;
    }
    return out;
  }

  // битые записи в списке наборов (правили файл настроек руками) выкидываем
  const cleanSets = (sets) => (Array.isArray(sets) ? sets.filter((s) => s && s.id) : []);

  // Полное имя эмоута: у своего — с id эмоута на 7TV, по нему свой эмоут
  // узнаёт чужое расширение; у эмоута набора — с постфиксом набора, чтобы
  // он не спутался с одноимённым из другого набора и с обычным словом.
  const fullName = (g, name, em) =>
    em && em.id ? `${name}_${em.id}` : g.suffix ? `${name}_${g.suffix}` : name;

  const DEFAULTS = {
    enabled: true,
    useGlobal: true,
    widget: true,
    suggest: true,
    everywhere: false,
    sets: [],
    customEmotes: {},
    favorites: [],
  };

  /**
   * Разделы в порядке показа: «Свои», глобальный, дальше наборы в порядке
   * списка — он же задаёт приоритет при коллизии кодов.
   * missing — сколько подключённых наборов сидит без кэша: по этому числу
   * попап и поповер говорят «эмоуты не скачались», а не «наборов нет».
   */
  async function load() {
    const settings = await chrome.storage.sync.get(DEFAULTS);
    const local = await chrome.storage.local.get({ setEmotes: {}, globalEmotes: null });
    settings.sets = cleanSets(settings.sets);

    const groups = [];
    const custom = cleanEmotes(settings.customEmotes);
    if (Object.keys(custom).length) {
      // «Свои» — первым разделом: их не переставишь (у них нет setId),
      // а лезть за ними в конец списка неудобно
      groups.push({ key: 'custom', kind: 'custom', title: 'Свои', setId: '', suffix: '', emotes: custom });
    }
    if (settings.useGlobal) {
      // глобальный набор берём из кэша, а без кэша — из встроенной копии
      const g =
        local.globalEmotes && Object.keys(local.globalEmotes).length
          ? local.globalEmotes
          : DEFAULT_EMOTES;
      groups.push({
        key: 'global',
        kind: 'global',
        title: 'Глобальные 7TV',
        setId: '',
        suffix: '',
        emotes: cleanEmotes(g),
      });
    }
    let missing = 0;
    for (const s of settings.sets) {
      const emotes = cleanEmotes(local.setEmotes[s.id]);
      if (!Object.keys(emotes).length) {
        missing++;
        continue;
      }
      // key — по нему помнится, свёрнут ли набор; берём id, а не название:
      // переименованный на 7TV набор должен остаться свёрнутым
      groups.push({
        key: `set:${s.id}`,
        kind: 'set',
        title: s.name || s.id,
        setId: s.id,
        suffix: s.slug || '',
        emotes,
      });
    }
    return { settings, groups, missing };
  }

  // Второе имя эмоута — с постфиксом набора или с id своего эмоута. Пометка
  // a — «это второе имя», по ней автозаполнение прячет дубли, а вставка
  // берёт голое имя. id сюда не переносим: он уже в самом имени, иначе
  // в сообщение уехало бы имя_id_id.
  const alias = (em, bare) => ({ u: em.u, z: em.z, r: em.r, a: bare });

  /**
   * Плоская карта «имя -> эмоут» для подмены в тексте и для списка в попапе.
   *
   * Голое имя достаётся глобальному набору, затем набору, который выше
   * в списке, а свои эмоуты перебивают всех: их добавил сам пользователь.
   * У эмоута набора есть и второе имя — имя_постфикс, оно доступно всегда.
   */
  function flatten(groups) {
    const map = new Map();
    const byKind = (kind) => groups.filter((g) => g.kind === kind);

    for (const g of byKind('global')) {
      for (const [n, em] of Object.entries(g.emotes)) map.set(n, em);
    }
    const fromSets = new Map(); // голое имя -> эмоуты наборов с этим кодом
    for (const g of byKind('set')) {
      for (const [n, em] of Object.entries(g.emotes)) {
        if (g.suffix) map.set(`${n}_${g.suffix}`, alias(em, n));
        const list = fromSets.get(n);
        if (list) list.push(em);
        else fromSets.set(n, [em]);
      }
    }
    for (const [n, list] of fromSets) {
      if (map.has(n)) continue; // занято глобальным
      map.set(n, list[0]); // кандидаты складывались в порядке списка наборов
    }
    for (const g of byKind('custom')) {
      for (const [n, em] of Object.entries(g.emotes)) {
        map.set(n, em);
        if (em.id) map.set(`${n}_${em.id}`, alias(em, n));
      }
    }
    return map;
  }

  return { load, flatten, fullName, normEmote, usable, cleanEmotes, cleanSets };
})();

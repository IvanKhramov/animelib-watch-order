import type { OrderProfile } from '../orderProfiles';

// Порядки сообщества и редакционные решения; источники подтверждают указанные рядом факты.
export const CURATED_PROFILES: OrderProfile[] = [
  {
    "id": "monogatari",
    "title": "Monogatari",
    "anchorIds": [5081, 9260, 11597, 15689, 17074, 20593, 20918, 21520, 21262, 21745, 100815, 173533, 21399, 21400],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 5081, "title": "Bakemonogatari", "note": "Все 15 серий, включая сетевые 13–15."},
        {"alId": 9260, "title": "Kizumonogatari I: Tekketsu-hen"},
        {"alId": 21399, "title": "Kizumonogatari II: Nekketsu-hen"},
        {"alId": 21400, "title": "Kizumonogatari III: Reiketsu-hen"},
        {"alId": 11597, "title": "Nisemonogatari"},
        {"alId": 15689, "title": "Nekomonogatari (Kuro)"},
        {"alId": 17074, "title": "Monogatari Series: Second Season", "episodes": "1–11"},
        {"alId": 20593, "title": "Hanamonogatari"},
        {"alId": 17074, "title": "Monogatari Series: Second Season", "episodes": "12–26"},
        {"alId": 20918, "title": "Tsukimonogatari"},
        {"alId": 21520, "title": "Koyomimonogatari"},
        {"alId": 21262, "title": "Owarimonogatari"},
        {"alId": 21745, "title": "Owarimonogatari (Ge)"},
        {"alId": 100815, "title": "Zoku Owarimonogatari"},
        {"alId": 173533, "title": "Monogatari Series: Off & Monster Season"}
      ],
      "note": "Выбран порядок публикации романов. Hanamonogatari вставлена внутрь Second Season; он отличается от порядка аниме-релизов. Это редакционный выбор для первого просмотра, а не официальное предписание.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_monogatari_.2F_bakemonogatari",
          "detail": "Раздел Novel Release Order: конкретный порядок и разбиение Second Season 1–11 / 12–26."
        },
        {
          "label": "Официальный портал Monogatari",
          "url": "https://www.monogatari-series.com/series/?code=monogatari-series",
          "detail": "Состав Second Season и принадлежность Hana к этому циклу."
        }
      ]
    },
    "chronologyUnavailable": "Полная событийная карта не проверена: арки пересекаются, требуются многочисленные переходы между сериями. Сортировка целых сезонов будет неверной.",
    "limitations": [
      "Диапазоны Second Season используют исходную 26-серийную нумерацию с recap-сериями; в изданиях без пересказов номера сдвинуты.",
      "Off & Monster Season оставлен в порядке эпизодов своего издания; это не восстановленная хронология событий.",
      "Новая Shin Episode и Koyomi Vamp не добавлены в проверенный маршрут; Koyomi Vamp — альтернативное сокращённое издание Kizu."
    ]
  },
  {
    "id": "fate-stay-night",
    "title": "Fate/stay night и Fate/Zero",
    "anchorIds": [356, 6922, 19603, 20792, 20791, 21718, 21719, 10087, 11741, 21318],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 19603, "title": "Fate/stay night: Unlimited Blade Works", "note": "Включая пролог, обычно обозначенный серией 0."},
        {"alId": 20792, "title": "Fate/stay night: Unlimited Blade Works 2nd Season"},
        {"alId": 21318, "title": "Fate/stay night: Unlimited Blade Works 2nd Season - sunny day", "optional": true, "note": "Альтернативная концовка UBW."},
        {"alId": 20791, "title": "Fate/stay night [Heaven's Feel] I. presage flower"},
        {"alId": 21718, "title": "Fate/stay night [Heaven's Feel] II. lost butterfly"},
        {"alId": 21719, "title": "Fate/stay night [Heaven's Feel] III. spring song"},
        {"alId": 10087, "title": "Fate/Zero"},
        {"alId": 11741, "title": "Fate/Zero 2nd Season"}
      ],
      "note": "Выбран anime-only маршрут сообщества: UBW → Heaven’s Feel → Zero. Zero раскрывает часть загадок Stay Night; варианты Stay Night показывают разные исходы одних событий.",
      "sources": [
        {
          "label": "r/fatestaynight — Viewing Order Guide (гайд сообщества)",
          "url": "https://www.reddit.com/r/fatestaynight/comments/df8rvo/rfatestaynights_official_viewing_order_guide_v2/",
          "detail": "Anime-only UBW → три Heaven’s Feel → два сезона Zero; Sunny Day после UBW."
        },
        {
          "label": "Официальный сайт Fate/Zero",
          "url": "https://www.fate-zero.jp/introduction/",
          "detail": "Zero рассказывает о войне за десять лет до событий Stay Night."
        },
        {
          "label": "r/anime — Fate FAQ",
          "url": "https://www.reddit.com/r/anime/wiki/seriesfaq/fate/",
          "detail": "Три альтернативных маршрута Stay Night; отделение спин-оффов от основной ветки."
        }
      ]
    },
    "chronologyUnavailable": "Единой линейной хронологии нет: Fate, UBW и Heaven’s Feel — альтернативные ветки. Zero происходит раньше; последовательность Zero → UBW → Heaven’s Feel ошибочно изображала бы последние две ветки продолжениями.",
    "limitations": [
      "Версии DEEN 2006 и UBW 2010 — отдельные адаптации, не обязательные промежуточные сезоны.",
      "Слово Official в названии Reddit-поста означает утверждённый гайд сообщества, не позицию TYPE-MOON."
    ]
  },
  {
    "id": "steins-gate",
    "title": "Steins;Gate",
    "anchorIds": [9253, 21127, 21624, 10863, 11577, 104174],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 9253, "title": "Steins;Gate", "episodes": "1–24"},
        {"alId": 21624, "title": "Steins;Gate: Kyoukaimenjou no Missing Link - Divide By Zero", "note": "Альтернативная серия 23β, вход в Steins;Gate 0."},
        {"alId": 21127, "title": "Steins;Gate 0"},
        {"alId": 104174, "title": "Steins;Gate 0: Kesshou Takei no Valentine - Bittersweet Day", "optional": true},
        {"alId": 10863, "title": "Steins;Gate: Oukoubakko no Poriomania", "optional": true},
        {"alId": 11577, "title": "Steins;Gate: Fuka Ryouiki no Déjà vu", "optional": true}
      ],
      "note": "Для первого просмотра закончить оригинальный сериал, затем 23β и Zero. OVA и фильм — дополнения.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_steins.3Bgate",
          "detail": "Оба маршрута: целыми сериалами и с переходами по эпизодам."
        }
      ]
    },
    "chronological": {
      "steps": [
        {"alId": 9253, "title": "Steins;Gate", "episodes": "1–22"},
        {"alId": 21624, "title": "Steins;Gate: Kyoukaimenjou no Missing Link - Divide By Zero"},
        {"alId": 21127, "title": "Steins;Gate 0", "episodes": "1–11"},
        {"alId": 104174, "title": "Steins;Gate 0: Kesshou Takei no Valentine - Bittersweet Day", "optional": true},
        {"alId": 21127, "title": "Steins;Gate 0", "episodes": "12–23"},
        {"alId": 9253, "title": "Steins;Gate", "episodes": "23–24"},
        {"alId": 10863, "title": "Steins;Gate: Oukoubakko no Poriomania", "optional": true},
        {"alId": 11577, "title": "Steins;Gate: Fuka Ryouiki no Déjà vu", "optional": true}
      ],
      "note": "Альтернативный маршрут по причинной последовательности временных линий. Требует переходов между сериалами; для повторного просмотра.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_steins.3Bgate",
          "detail": "Оба маршрута: целыми сериалами и с переходами по эпизодам."
        }
      ]
    },
    "limitations": [
      "Это маршрут по веткам истории, не календарная сортировка сцен: события временных петель повторяются.",
      "В отдельных каталогах альтернативная 23β включена в сезон; не заменять ею обычную 23-ю серию при первом просмотре."
    ]
  },
  {
    "id": "madoka-magica",
    "title": "Madoka Magica",
    "anchorIds": [9756, 11977, 11979, 11981, 133007],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 9756, "title": "Mahou Shoujo Madoka☆Magica"},
        {"alId": 11981, "title": "Mahou Shoujo Madoka☆Magica: Hangyaku no Monogatari"},
        {"alId": 133007, "title": "Mahou Shoujo Madoka☆Magica: Walpurgis no Kaiten"}
      ],
      "note": "Основная линия: сериал → Rebellion → Walpurgisnacht Rising. Первые два фильма пересказывают сериал и служат альтернативным изданием, а не его продолжением.",
      "sources": [
        {
          "label": "Официальный сайт Walpurgisnacht Rising",
          "url": "https://www.madoka-magica.com/wr/",
          "detail": "Прямое продолжение Rebellion; первые два фильма названы перемонтированной версией сериала."
        },
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_madoka_magica",
          "detail": "Для первого просмотра выбран сериал, Magia Record обозначен отдельной историей."
        }
      ]
    },
    "chronologyUnavailable": "Внутри сериала есть временные петли и предыстория. Проверенная схема перестановки эпизодов для полной событийной хронологии не найдена.",
    "limitations": [
      "Magia Record — самостоятельный спин-офф, его нельзя механически вставить между основными фильмами."
    ]
  },
  {
    "id": "mushoku-tensei",
    "title": "Реинкарнация безработного",
    "anchorIds": [108465, 127720, 141534, 146065, 166873, 178789],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 108465, "title": "Mushoku Tensei: Isekai Ittara Honki Dasu"},
        {"alId": 127720, "title": "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2"},
        {"alId": 141534, "title": "Mushoku Tensei: Isekai Ittara Honki Dasu Part 2 - Eris no Goblin Toubatsu", "note": "Дополнение об Эрис, смотреть до второго сезона."},
        {"alId": 146065, "title": "Mushoku Tensei II: Isekai Ittara Honki Dasu", "note": "Включая вводную серию 0 о Фиттсе, если она есть в данном издании."},
        {"alId": 166873, "title": "Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2"},
        {"alId": 178789, "title": "Mushoku Tensei III: Isekai Ittara Honki Dasu"}
      ],
      "note": "Редакционный маршрут: сезоны по продолжению истории, OVA об Эрис после первого сезона.",
      "sources": [
        {
          "label": "Официальный Mushoku: OVA Эрис",
          "url": "https://mushokutensei.jp/news/220302_1/",
          "detail": "OVA происходит одновременно с общей серией 16: Рудеус встречает Пауля, Эрис и Руйджерд проводят этот день отдельно."
        },
        {
          "label": "Официальный Mushoku: серия 16",
          "url": "https://mushokutensei.jp/story/16/",
          "detail": "Место события OVA в первом сезоне."
        },
        {
          "label": "Официальный Mushoku: сезон 2, серия 0",
          "url": "https://mushokutensei.jp/news/230628_1/",
          "detail": "Вводная серия второго сезона имеет номер 0."
        },
        {
          "label": "Официальный Mushoku: текущие выпуски",
          "url": "https://mushokutensei.jp/2024/",
          "detail": "Третий сезон существует и выходил летом 2026 года."
        }
      ]
    },
    "chronologyUnavailable": "Подтверждена вставка OVA рядом с общей серией 16 (Part 2, серия 5). Полный маршрут с серией 0 второго сезона и пересекающейся предысторией не проверен; автоматически считать его хронологическим нельзя.",
    "limitations": [
      "Точное локальное положение OVA: Part 2 серии 1–5 → OVA → Part 2 серии 6–12; это подтверждённая вставка, но не полная хронология всей франшизы.",
      "Поздние анонсы за пределами проверенного маршрута."
    ]
  },
  {
    "id": "konosuba",
    "title": "KonoSuba",
    "anchorIds": [21202, 21574, 21699, 97996, 102976, 150075, 136804, 181244],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 21202, "title": "Kono Subarashii Sekai ni Shukufuku wo!"},
        {"alId": 21699, "title": "Kono Subarashii Sekai ni Shukufuku wo! 2", "episodes": "1–4"},
        {"alId": 21574, "title": "Kono Subarashii Sekai ni Shukufuku wo!: Kono Subarashii Choker ni Shukufuku wo!", "optional": true},
        {"alId": 21699, "title": "Kono Subarashii Sekai ni Shukufuku wo! 2", "episodes": "5–10"},
        {"alId": 97996, "title": "Kono Subarashii Sekai ni Shukufuku wo! 2: Kono Subarashii Geijutsu ni Shukufuku wo!", "optional": true},
        {"alId": 150075, "title": "Kono Subarashii Sekai ni Bakuen wo!", "optional": true, "note": "Приквел о Мэгумин; здесь уже понятны отсылки к основной истории."},
        {"alId": 102976, "title": "Kono Subarashii Sekai ni Shukufuku wo! Kurenai Densetsu"},
        {"alId": 136804, "title": "Kono Subarashii Sekai ni Shukufuku wo! 3"},
        {"alId": 181244, "title": "Kono Subarashii Sekai ni Shukufuku wo! 3: BONUS STAGE", "optional": true}
      ],
      "note": "Первую OVA удобно вставить после 4-й серии второго сезона. Приквел о Мэгумин оставлен после знакомства с основной командой.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_kono_subarashii_sekai_ni_shukufuku_wo.21",
          "detail": "Разбиение второго сезона вокруг первой OVA и рекомендация смотреть Bakuen после второго сезона."
        },
        {
          "label": "Официальный KonoSuba: Bonus Stage",
          "url": "https://konosuba.com/3rd/ova/story/",
          "detail": "Две дополнительные истории к третьему сезону; точная позиция в общей хронологии не установлена."
        }
      ]
    },
    "chronologyUnavailable": "Положение Bakuen как приквела и первой OVA внутри S2 проверено, но точное событийное место Bonus Stage не установлено. Полный событийный маршрут пока не опубликован.",
    "limitations": [
      "Для отдельных OVA порядок выхода и событийное место различаются.",
      "Четвёртый сезон не включён в проверенный маршрут."
    ]
  },
  {
    "id": "kaguya-sama",
    "title": "Госпожа Кагуя",
    "anchorIds": [101921, 112641, 125368, 165557, 125367, 151384],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 101921, "title": "Kaguya-sama wa Kokurasetai: Tensaitachi no Renai Zunousen"},
        {"alId": 112641, "title": "Kaguya-sama wa Kokurasetai?: Tensaitachi no Renai Zunousen"},
        {"alId": 125368, "title": "Kaguya-sama wa Kokurasetai: Tensaitachi no Renai Zunousen OVA", "optional": true},
        {"alId": 165557, "title": "Kaguya-sama wa Kokurasetai: Ultra Romantic 3rd Season Teaser PV - Ishigami Yuu wa Kataritai", "optional": true},
        {"alId": 125367, "title": "Kaguya-sama wa Kokurasetai: Ultra Romantic"},
        {"alId": 151384, "title": "Kaguya-sama wa Kokurasetai: First Kiss wa Owaranai"}
      ],
      "note": "Основная линия сезонов; OVA и короткий Ishigami Yuu wa Kataritai перед третьим сезоном. First Kiss продолжает Ultra Romantic.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_kaguya-sama.3A_love_is_war",
          "detail": "Последовательность S1 → S2 → OVA → ONA → Ultra Romantic → First Kiss."
        }
      ]
    },
    "chronologyUnavailable": "Гэги и OVA не проверены на покадровую/поэпизодную хронологию. Порядок выхода дополнений не выдаётся за событийный.",
    "limitations": [
      "Otona e no Kaidan (AL 194884) существует, но точное место его отдельных эпизодов в событийной карте здесь не проверено.",
      "Kanketsu-hen (AL 205081) не включён."
    ]
  },
  {
    "id": "attack-on-titan",
    "title": "Атака титанов",
    "anchorIds": [16498, 18397, 20811, 20958, 99634, 99147, 104578, 110277, 131681, 146984, 162314],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 16498, "title": "Shingeki no Kyojin"},
        {"alId": 18397, "title": "Shingeki no Kyojin OVA", "optional": true},
        {"alId": 20811, "title": "Shingeki no Kyojin Gaiden: Kuinaki Sentaku", "optional": true},
        {"alId": 20958, "title": "Shingeki no Kyojin Season 2"},
        {"alId": 99634, "title": "Shingeki no Kyojin: LOST GIRLS", "episodes": "1–2", "optional": true},
        {"alId": 99147, "title": "Shingeki no Kyojin Season 3"},
        {"alId": 99634, "title": "Shingeki no Kyojin: LOST GIRLS", "episodes": "3", "optional": true, "note": "Эта история отделена от первых двух Lost Girls."},
        {"alId": 104578, "title": "Shingeki no Kyojin Season 3 Part 2"},
        {"alId": 110277, "title": "Shingeki no Kyojin: The Final Season"},
        {"alId": 131681, "title": "Shingeki no Kyojin: The Final Season Part 2"},
        {"alId": 146984, "title": "Shingeki no Kyojin: The Final Season - Kanketsu-hen Zenpen"},
        {"alId": 162314, "title": "Shingeki no Kyojin: The Final Season - Kanketsu-hen Kouhen"}
      ],
      "note": "Первый просмотр с OVA в местах, где они не опережают раскрытия основной истории. Lost Girls нужно разделить на 1–2 и 3.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_attack_on_titan",
          "detail": "Точное размещение обеих частей Lost Girls и No Regrets относительно сезонов."
        }
      ]
    },
    "chronologyUnavailable": "Полная событийная карта не проверена: No Regrets — предыстория, Lost Girls и основной сюжет включают ретроспективы. Порядок для первого просмотра не является строгой хронологией.",
    "limitations": [
      "Пересказы и альтернативные монтажи финала оставлены за пределами основного маршрута."
    ]
  },
  {
    "id": "jojo",
    "title": "Невероятные приключения ДжоДжо",
    "anchorIds": [14719, 20474, 20799, 21450, 21778, 102883, 131942, 146722, 190327, 210482],
    "checkedAt": "2026-10-17",
    "recommended": {
      "steps": [
        {"alId": 14719, "title": "JoJo no Kimyou na Bouken (TV)"},
        {"alId": 20474, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders"},
        {"alId": 20799, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen"},
        {"alId": 21450, "title": "JoJo no Kimyou na Bouken: Diamond wa Kudakenai"},
        {"alId": 21778, "title": "Kishibe Rohan wa Ugokanai", "optional": true},
        {"alId": 102883, "title": "JoJo no Kimyou na Bouken: Ougon no Kaze"},
        {"alId": 131942, "title": "JoJo no Kimyou na Bouken: Stone Ocean"},
        {"alId": 146722, "title": "JoJo no Kimyou na Bouken: Stone Ocean Part 2", "note": "В AniList это 26 серий: объединённые блоки Stone Ocean 2 и 3."},
        {"alId": 190327, "title": "JoJo no Kimyou na Bouken: Steel Ball Run - 1st STAGE", "note": "Начало другой сюжетной линии; это не возвращение в прошлое мира Stone Ocean."},
        {"alId": 210482, "title": "JoJo no Kimyou na Bouken: Steel Ball Run - 2nd & 3rd STAGE"}
      ],
      "note": "Части основной адаптации по порядку, Rohan необязателен после Diamond. Затем отдельная линия Steel Ball Run.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_jojo.27s_bizarre_adventure",
          "detail": "Порядок адаптации, Rohan после Diamond, старые OVA как альтернативные адаптации."
        },
        {
          "label": "Официальный портал JoJo: аниме",
          "url": "https://jojo-portal.com/en/anime/",
          "detail": "Преемственность основных частей, Stone Ocean в 2011 году, Rohan как отдельная коллекция историй."
        },
        {
          "label": "AniList: Stone Ocean Part 2",
          "url": "https://anilist.co/anime/146722/JoJo-no-Kimyou-na-Bouken-Stone-Ocean-Part-2",
          "detail": "AL 146722 содержит 26 серий; отдельного AL ID для Netflix Part 3 нет."
        }
      ]
    },
    "chronological": {
      "steps": [
        {"alId": 14719, "title": "JoJo no Kimyou na Bouken (TV)"},
        {"alId": 20474, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders"},
        {"alId": 20799, "title": "JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen"},
        {"alId": 21450, "title": "JoJo no Kimyou na Bouken: Diamond wa Kudakenai"},
        {"alId": 102883, "title": "JoJo no Kimyou na Bouken: Ougon no Kaze"},
        {"alId": 131942, "title": "JoJo no Kimyou na Bouken: Stone Ocean"},
        {"alId": 146722, "title": "JoJo no Kimyou na Bouken: Stone Ocean Part 2", "note": "В AniList это 26 серий: объединённые блоки Stone Ocean 2 и 3."}
      ],
      "note": "Только исходная линия Phantom Blood → Stone Ocean. Steel Ball Run и эпизодические истории Rohan не вставлены в общую временную шкалу.",
      "sources": [
        {
          "label": "r/anime — Watch Order Wiki (порядок сообщества)",
          "url": "https://www.reddit.com/r/anime/wiki/watch_order/#wiki_jojo.27s_bizarre_adventure",
          "detail": "Порядок адаптации, Rohan после Diamond, старые OVA как альтернативные адаптации."
        },
        {
          "label": "Официальный портал JoJo: аниме",
          "url": "https://jojo-portal.com/en/anime/",
          "detail": "Преемственность основных частей, Stone Ocean в 2011 году, Rohan как отдельная коллекция историй."
        },
        {
          "label": "AniList: Stone Ocean Part 2",
          "url": "https://anilist.co/anime/146722/JoJo-no-Kimyou-na-Bouken-Stone-Ocean-Part-2",
          "detail": "AL 146722 содержит 26 серий; отдельного AL ID для Netflix Part 3 нет."
        }
      ]
    },
    "limitations": [
      "AniList объединяет Netflix Stone Ocean Part 2 и Part 3 в AL 146722; нельзя создавать выдуманный AniList ID для третьего блока.",
      "Событийный маршрут ограничен основной исходной линией, флешбэки внутри серий не переставляются."
    ]
  }
];

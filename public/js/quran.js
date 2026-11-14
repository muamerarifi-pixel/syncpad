// Official public Quran audio picker (MP3Quran API v3 & Quran.com QDC CDNs, CORS-enabled).
// Provides offline-capable 114 Surah catalog + curated reciters + live 200+ reciter discovery.

export const SURAHS = [
  [1, "Al-Fatihah", "The Opener", "الفاتحة"],
  [2, "Al-Baqarah", "The Cow", "البقرة"],
  [3, "Ali 'Imran", "Family of Imran", "آل عمران"],
  [4, "An-Nisa", "The Women", "النساء"],
  [5, "Al-Ma'idah", "The Table Spread", "المائدة"],
  [6, "Al-An'am", "The Cattle", "الأنعام"],
  [7, "Al-A'raf", "The Heights", "الأعراف"],
  [8, "Al-Anfal", "The Spoils of War", "الأنفال"],
  [9, "At-Tawbah", "The Repentance", "التوبة"],
  [10, "Yunus", "Jonah", "يونس"],
  [11, "Hud", "Hud", "هود"],
  [12, "Yusuf", "Joseph", "يوسف"],
  [13, "Ar-Ra'd", "The Thunder", "الرعد"],
  [14, "Ibrahim", "Abraham", "ابراهيم"],
  [15, "Al-Hijr", "The Rocky Tract", "الحجر"],
  [16, "An-Nahl", "The Bee", "النحل"],
  [17, "Al-Isra", "The Night Journey", "الإسراء"],
  [18, "Al-Kahf", "The Cave", "الكهف"],
  [19, "Maryam", "Mary", "مريم"],
  [20, "Taha", "Ta-Ha", "طه"],
  [21, "Al-Anbya", "The Prophets", "الأنبياء"],
  [22, "Al-Hajj", "The Pilgrimage", "الحج"],
  [23, "Al-Mu'minun", "The Believers", "المؤمنون"],
  [24, "An-Nur", "The Light", "النور"],
  [25, "Al-Furqan", "The Criterion", "الفرقان"],
  [26, "Ash-Shu'ara", "The Poets", "الشعراء"],
  [27, "An-Naml", "The Ant", "النمل"],
  [28, "Al-Qasas", "The Stories", "القصص"],
  [29, "Al-'Ankabut", "The Spider", "العنكبوت"],
  [30, "Ar-Rum", "The Romans", "الروم"],
  [31, "Luqman", "Luqman", "لقمان"],
  [32, "As-Sajdah", "The Prostration", "السجدة"],
  [33, "Al-Ahzab", "The Combined Forces", "الأحزاب"],
  [34, "Saba", "Sheba", "سبإ"],
  [35, "Fatir", "Originator", "فاطر"],
  [36, "Ya-Sin", "Ya Sin", "يس"],
  [37, "As-Saffat", "Those who set the Ranks", "الصافات"],
  [38, "Sad", "The Letter \"Saad\"", "ص"],
  [39, "Az-Zumar", "The Troops", "الزمر"],
  [40, "Ghafir", "The Forgiver", "غافر"],
  [41, "Fussilat", "Explained in Detail", "فصلت"],
  [42, "Ash-Shuraa", "The Consultation", "الشورى"],
  [43, "Az-Zukhruf", "The Ornaments of Gold", "الزخرف"],
  [44, "Ad-Dukhan", "The Smoke", "الدخان"],
  [45, "Al-Jathiyah", "The Crouching", "الجاثية"],
  [46, "Al-Ahqaf", "The Wind-Curved Sandhills", "الأحقاف"],
  [47, "Muhammad", "Muhammad", "محمد"],
  [48, "Al-Fath", "The Victory", "الفتح"],
  [49, "Al-Hujurat", "The Rooms", "الحجرات"],
  [50, "Qaf", "The Letter \"Qaf\"", "ق"],
  [51, "Adh-Dhariyat", "The Winnowing Winds", "الذاريات"],
  [52, "At-Tur", "The Mount", "الطور"],
  [53, "An-Najm", "The Star", "النجم"],
  [54, "Al-Qamar", "The Moon", "القمر"],
  [55, "Ar-Rahman", "The Beneficent", "الرحمن"],
  [56, "Al-Waqi'ah", "The Inevitable", "الواقعة"],
  [57, "Al-Hadid", "The Iron", "الحديد"],
  [58, "Al-Mujadila", "The Pleading Woman", "المجادلة"],
  [59, "Al-Hashr", "The Exile", "الحشر"],
  [60, "Al-Mumtahanah", "She that is to be examined", "الممتحنة"],
  [61, "As-Saf", "The Ranks", "الصف"],
  [62, "Al-Jumu'ah", "The Congregation, Friday", "الجمعة"],
  [63, "Al-Munafiqun", "The Hypocrites", "المنافقون"],
  [64, "At-Taghabun", "The Mutual Disillusion", "التغابن"],
  [65, "At-Talaq", "The Divorce", "الطلاق"],
  [66, "At-Tahrim", "The Prohibition", "التحريم"],
  [67, "Al-Mulk", "The Sovereignty", "الملك"],
  [68, "Al-Qalam", "The Pen", "القلم"],
  [69, "Al-Haqqah", "The Reality", "الحاقة"],
  [70, "Al-Ma'arij", "The Ascending Stairways", "المعارج"],
  [71, "Nuh", "Noah", "نوح"],
  [72, "Al-Jinn", "The Jinn", "الجن"],
  [73, "Al-Muzzammil", "The Enshrouded One", "المزمل"],
  [74, "Al-Muddaththir", "The Cloaked One", "المدثر"],
  [75, "Al-Qiyamah", "The Resurrection", "القيامة"],
  [76, "Al-Insan", "The Man", "الانسان"],
  [77, "Al-Mursalat", "The Emissaries", "المرسلات"],
  [78, "An-Naba", "The Tidings", "النبإ"],
  [79, "An-Nazi'at", "Those who drag forth", "النازعات"],
  [80, "'Abasa", "He Frowned", "عبس"],
  [81, "At-Takwir", "The Overthrowing", "التكوير"],
  [82, "Al-Infitar", "The Cleaving", "الإنفطار"],
  [83, "Al-Mutaffifin", "The Defrauding", "المطففين"],
  [84, "Al-Inshiqaq", "The Sundering", "الإنشقاق"],
  [85, "Al-Buruj", "The Mansions of the Stars", "البروج"],
  [86, "At-Tariq", "The Nightcommer", "الطارق"],
  [87, "Al-A'la", "The Most High", "الأعلى"],
  [88, "Al-Ghashiyah", "The Overwhelming", "الغاشية"],
  [89, "Al-Fajr", "The Dawn", "الفجر"],
  [90, "Al-Balad", "The City", "البلد"],
  [91, "Ash-Shams", "The Sun", "الشمس"],
  [92, "Al-Layl", "The Night", "الليل"],
  [93, "Ad-Duhaa", "The Morning Hours", "الضحى"],
  [94, "Ash-Sharh", "The Relief", "الشرح"],
  [95, "At-Tin", "The Fig", "التين"],
  [96, "Al-'Alaq", "The Clot", "العلق"],
  [97, "Al-Qadr", "The Power", "القدر"],
  [98, "Al-Bayyinah", "The Clear Proof", "البينة"],
  [99, "Az-Zalzalah", "The Earthquake", "الزلزلة"],
  [100, "Al-'Adiyat", "The Courser", "العاديات"],
  [101, "Al-Qari'ah", "The Calamity", "القارعة"],
  [102, "At-Takathur", "The Rivalry in world increase", "التكاثر"],
  [103, "Al-'Asr", "The Declining Day", "العصر"],
  [104, "Al-Humazah", "The Traducer", "الهمزة"],
  [105, "Al-Fil", "The Elephant", "الفيل"],
  [106, "Quraysh", "Quraysh", "قريش"],
  [107, "Al-Ma'un", "The Small kindnesses", "الماعون"],
  [108, "Al-Kawthar", "The Abundance", "الكوثر"],
  [109, "Al-Kafirun", "The Disbelievers", "الكافرون"],
  [110, "An-Nasr", "The Divine Support", "النصر"],
  [111, "Al-Masad", "The Palm Fiber", "المسد"],
  [112, "Al-Ikhlas", "The Sincerity", "الإخلاص"],
  [113, "Al-Falaq", "The Daybreak", "الفلق"],
  [114, "An-Nas", "Mankind", "الناس"]
];

export const CURATED_RECITERS = [
  {
    id: 'mp3q:123',
    name: 'Mishary Rashid Alafasy',
    ar: 'مشاري العفاسي',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/mishary-alafasy/r1/',
    qdcServer: 'https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/',
    qdcPad: false,
    qdcId: 7
  },
  {
    id: 'mp3q:102',
    name: 'Maher Al-Muaiqly',
    ar: 'ماهر المعيقلي',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/maher-muaiqly/r1/'
  },
  {
    id: 'mp3q:54',
    name: 'Abdulrahman Al-Sudais',
    ar: 'عبدالرحمن السديس',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/abdulrahman-sudais/r1/',
    qdcServer: 'https://download.quranicaudio.com/qdc/abdurrahmaan_as_sudais/murattal/',
    qdcPad: false,
    qdcId: 3
  },
  {
    id: 'mp3q:118',
    name: 'Mahmoud Khalil Al-Hussary',
    ar: 'محمود خليل الحصري',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/mahmoud-husary/r1/',
    qdcServer: 'https://download.quranicaudio.com/qdc/khalil_al_husary/murattal/',
    qdcPad: false,
    qdcId: 6
  },
  {
    id: 'mp3q:112',
    name: 'Mohammed Siddiq Al-Minshawi',
    ar: 'محمد صديق المنشاوي',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/muhammad-minshawi/r1/',
    qdcServer: 'https://download.quranicaudio.com/qdc/siddiq_minshawi/murattal/',
    qdcPad: false,
    qdcId: 9
  },
  {
    id: 'mp3q:31',
    name: 'Saud Al-Shuraim',
    ar: 'سعود الشريم',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/saud-shuraim/r1/',
    qdcServer: 'https://download.quranicaudio.com/qdc/saud_ash-shuraym/murattal/',
    qdcPad: true,
    qdcId: 10
  },
  {
    id: 'mp3q:51',
    name: 'Abdulbasit Abdulsamad',
    ar: 'عبدالباسط عبدالصمد',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/abdulbasit-abdulsamad/r3/',
    qdcServer: 'https://download.quranicaudio.com/qdc/abdul_baset/murattal/',
    qdcPad: false,
    qdcId: 2
  },
  {
    id: 'mp3q:92',
    name: 'Yasser Al-Dosari',
    ar: 'ياسر الدوسري',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/yasser-dosari/r1/'
  },
  {
    id: 'mp3q:30',
    name: 'Saad Al-Ghamdi',
    ar: 'سعد الغامدي',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/saad-ghamdi/r1/'
  },
  {
    id: 'mp3q:5',
    name: 'Ahmad Al-Ajmy',
    ar: 'أحمد بن علي العجمي',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/ahmad-ajmi/r1/'
  },
  {
    id: 'mp3q:253',
    name: 'Islam Sobhi',
    ar: 'إسلام صبحي',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/islam-sobhi/r1/',
    surahList: '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,38,41,42,43,44,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114'
  },
  {
    id: 'mp3q:231',
    name: 'Hazza Al-Balushi',
    ar: 'هزاع البلوشي',
    style: 'Hafs · Murattal',
    server: 'https://cdn.mp3quran.net/audio/hazza-balushi/r1/',
    surahList: '1,6,8,12,13,14,15,17,18,19,20,21,22,25,29,30,31,32,34,35,36,37,38,39,40,41,42,43,44,45,46,47,49,50,51,52,53,54,55,56,57,61,63,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114'
  }
];

const RECITER_KEY = 'sp-quran-reciter';
let allRecitersPromise = null;
let cachedAllReciters = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normalizeLatin(s) {
  return String(s || '').toLowerCase().replace(/['`’\-]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeServer(server) {
  if (!server) return '';
  let s = String(server).trim();
  if (s.startsWith('http://')) s = 'https://' + s.slice(7);
  if (!s.endsWith('/')) s += '/';
  return s;
}

export function hasSurah(reciter, surahNum) {
  if (!reciter || !reciter.surahList) return true;
  if (!reciter._surahSet) {
    reciter._surahSet = new Set(String(reciter.surahList).split(',').map((x) => Number(x.trim())).filter(Boolean));
  }
  return reciter._surahSet.has(surahNum);
}

export function resolveSurahAudioUrls(reciter, surahNum) {
  const urls = [];
  const n = Number(surahNum);
  const pad3 = String(n).padStart(3, '0');
  const srv = normalizeServer(reciter && reciter.server);
  if (srv) urls.push(`${srv}${pad3}.mp3`);
  if (reciter && reciter.qdcServer) {
    const qSrv = normalizeServer(reciter.qdcServer);
    const file = reciter.qdcPad ? `${pad3}.mp3` : `${n}.mp3`;
    const u = `${qSrv}${file}`;
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

export async function resolveFallbackAudioUrl(reciter, surahNum) {
  if (!reciter || !reciter.qdcId) return '';
  try {
    const r = await fetch(`https://api.quran.com/api/v4/chapter_recitations/${reciter.qdcId}/${surahNum}`);
    if (!r.ok) return '';
    const j = await r.json();
    const u = j && j.audio_file && j.audio_file.audio_url;
    return typeof u === 'string' && u.startsWith('https://') ? u : '';
  } catch {
    return '';
  }
}

export async function fetchAllReciters() {
  if (cachedAllReciters) return cachedAllReciters;
  if (allRecitersPromise) return allRecitersPromise;
  allRecitersPromise = (async () => {
    try {
      const r = await fetch('https://www.mp3quran.net/api/v3/reciters?language=eng');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const byServer = new Set(CURATED_RECITERS.map((x) => normalizeServer(x.server)));
      const merged = CURATED_RECITERS.map((x) => ({ ...x, popular: true }));
      const extra = [];
      for (const rec of (j.reciters || [])) {
        const moshafs = Array.isArray(rec.moshaf) ? rec.moshaf : [];
        for (const m of moshafs) {
          const srv = normalizeServer(m.server);
          if (!srv || !srv.startsWith('https://')) continue;
          if (byServer.has(srv)) continue;
          byServer.add(srv);
          const styleRaw = String(m.name || '').replace(/^Rewayat\s+/i, '').trim();
          const showStyle = moshafs.length > 1 || (styleRaw && !/^Hafs A'n Assem\s*-\s*Murattal$/i.test(styleRaw));
          extra.push({
            id: `mp3q:${rec.id}:${m.id}`,
            name: rec.name,
            ar: '',
            style: showStyle ? styleRaw : 'Hafs · Murattal',
            server: srv,
            surahList: (m.surah_total || 0) >= 114 ? '' : (m.surah_list || ''),
            popular: false
          });
        }
      }
      extra.sort((a, b) => a.name.localeCompare(b.name));
      cachedAllReciters = [...merged, ...extra];
      return cachedAllReciters;
    } catch {
      return CURATED_RECITERS.map((x) => ({ ...x, popular: true }));
    } finally {
      allRecitersPromise = null;
    }
  })();
  return allRecitersPromise;
}

export function openQuranModal({ dlg, openDialog, closeDialog, onAdd, onPreview, getPlayingUrl }) {
  if (!dlg) return;

  if (!dlg.dataset.ready) {
    dlg.dataset.ready = '1';
    dlg.innerHTML =
      `<div class="sheet-head">` +
        `<div class="quran-head-txt">` +
          `<h2 id="quran-title">Quran Audio</h2>` +
          `<p class="quran-sub">Stream or embed any Surah offline in your note</p>` +
        `</div>` +
        `<button class="icon-btn" data-close aria-label="Close"><svg class="ic"><use href="#i-x"/></svg></button>` +
      `</div>` +
      `<div class="sheet-body quran-body">` +
        `<div class="quran-rec-box">` +
          `<div class="quran-rec-hdr">` +
            `<label for="quran-rec-select">Reciter</label>` +
            `<span class="quran-rec-badge" id="quran-rec-badge">Popular reciters</span>` +
          `</div>` +
          `<div class="quran-rec-inputs">` +
            `<input type="search" id="quran-rec-filter" class="quran-input" placeholder="Filter all reciters (e.g. Mishary, Maher, Sudais)…" aria-label="Filter reciters">` +
            `<select id="quran-rec-select" class="quran-select" aria-label="Choose reciter"></select>` +
          `</div>` +
        `</div>` +
        `<div class="quran-search-wrap">` +
          `<svg class="ic" aria-hidden="true"><use href="#i-search"/></svg>` +
          `<input type="search" id="quran-surah-search" class="quran-input" placeholder="Search Surah by number (1–114), English, or Arabic…" aria-label="Search Surah">` +
        `</div>` +
        `<div class="quran-list" id="quran-list"></div>` +
      `</div>`;
  }

  let reciters = (cachedAllReciters || CURATED_RECITERS).map((x) => ({ ...x }));
  let savedId = '';
  try { savedId = localStorage.getItem(RECITER_KEY) || ''; } catch {}
  let selectedReciter = reciters.find((r) => r.id === savedId) || reciters[0];

  const recBadge = dlg.querySelector('#quran-rec-badge');
  const recFilter = dlg.querySelector('#quran-rec-filter');
  const recSelect = dlg.querySelector('#quran-rec-select');
  const surahSearch = dlg.querySelector('#quran-surah-search');
  const listEl = dlg.querySelector('#quran-list');

  const getReciter = () => reciters.find((r) => r.id === recSelect.value) || selectedReciter || reciters[0];

  const renderReciters = () => {
    const q = normalizeLatin(recFilter.value);
    const matches = q
      ? reciters.filter((r) => normalizeLatin(`${r.name} ${r.ar} ${r.style}`).includes(q))
      : reciters;
    const prev = selectedReciter ? selectedReciter.id : recSelect.value;
    recSelect.innerHTML = matches.length
      ? matches.map((r) => {
          const suffix = r.ar ? ` · ${r.ar}` : (r.style && r.style !== 'Hafs · Murattal' ? ` (${r.style})` : '');
          return `<option value="${esc(r.id)}">${esc(r.name + suffix)}</option>`;
        }).join('')
      : `<option value="">No matching reciter</option>`;
    if (matches.some((r) => r.id === prev)) {
      recSelect.value = prev;
    } else if (matches.length) {
      recSelect.value = matches[0].id;
      selectedReciter = matches[0];
    }
    if (recBadge) {
      recBadge.textContent = cachedAllReciters
        ? (q ? `${matches.length} of ${reciters.length}` : `${reciters.length} reciters`)
        : `${reciters.length} popular`;
    }
  };

  const renderSurahs = () => {
    const rec = getReciter();
    const rawQ = surahSearch.value.trim();
    const qLatin = normalizeLatin(rawQ);
    const qNum = /^\d+$/.test(rawQ) ? Number(rawQ) : 0;
    const playingUrl = typeof getPlayingUrl === 'function' ? getPlayingUrl() : '';

    const items = [];
    for (const [num, en, tr, ar] of SURAHS) {
      if (!hasSurah(rec, num)) continue;
      if (rawQ) {
        const hitNum = qNum ? num === qNum || String(num).startsWith(rawQ) : false;
        const hitLatin = qLatin && normalizeLatin(`${en} ${tr} surah ${en}`).includes(qLatin);
        const hitAr = ar.includes(rawQ);
        if (!hitNum && !hitLatin && !hitAr) continue;
      }
      const urls = resolveSurahAudioUrls(rec, num);
      const isPlaying = Boolean(playingUrl && urls.includes(playingUrl));
      items.push(
        `<div class="quran-item${isPlaying ? ' is-playing' : ''}" data-surah="${num}">` +
          `<span class="quran-num">${num}</span>` +
          `<div class="quran-meta">` +
            `<div class="quran-en"><strong>${esc(en)}</strong> <span class="quran-tr">· ${esc(tr)}</span></div>` +
            `<div class="quran-ar" dir="rtl" lang="ar">سورة ${esc(ar)}</div>` +
          `</div>` +
          `<div class="quran-acts">` +
            `<button type="button" class="btn btn-soft btn-sm quran-prev" data-surah="${num}" aria-label="${isPlaying ? 'Pause' : 'Listen'} ${esc(en)}" title="${isPlaying ? 'Pause preview' : 'Listen now (streams online)'}">` +
              `<svg class="ic"><use href="#i-${isPlaying ? 'pause' : 'play'}"/></svg>` +
              `<span>${isPlaying ? 'Pause' : 'Listen'}</span>` +
            `</button>` +
            `<button type="button" class="btn btn-primary btn-sm quran-add" data-surah="${num}" title="Save MP3 into note for offline & lock-screen playback">+ MP3</button>` +
          `</div>` +
        `</div>`
      );
    }
    listEl.innerHTML = items.length
      ? items.join('')
      : `<div class="quran-empty">No matching Surah found for “${esc(rawQ)}”.</div>`;
  };

  // Rebind listeners cleanly on each open using a controller so handlers use the latest callbacks
  if (dlg._quranAC) dlg._quranAC.abort();
  const ac = new AbortController();
  dlg._quranAC = ac;
  const sig = ac.signal;

  recFilter.addEventListener('input', () => {
    renderReciters();
    renderSurahs();
  }, { signal: sig });

  recSelect.addEventListener('change', () => {
    const rec = getReciter();
    if (rec) {
      selectedReciter = rec;
      try { localStorage.setItem(RECITER_KEY, rec.id); } catch {}
    }
    renderSurahs();
  }, { signal: sig });

  surahSearch.addEventListener('input', renderSurahs, { signal: sig });

  listEl.addEventListener('click', (e) => {
    const prevBtn = e.target.closest('.quran-prev');
    const addBtn = e.target.closest('.quran-add');
    if (!prevBtn && !addBtn) return;
    const surahNum = Number((prevBtn || addBtn).dataset.surah);
    const s = SURAHS[surahNum - 1];
    const rec = getReciter();
    if (!s || !rec) return;
    const payload = {
      surahNum,
      surahNameEn: s[1],
      surahTransEn: s[2],
      surahNameAr: s[3],
      reciter: rec,
      reciterName: rec.name,
      urls: resolveSurahAudioUrls(rec, surahNum)
    };
    if (prevBtn) {
      if (typeof onPreview === 'function') onPreview(payload);
      setTimeout(renderSurahs, 30);
      return;
    }
    if (addBtn) {
      if (typeof closeDialog === 'function') closeDialog(dlg);
      else dlg.close();
      if (typeof onAdd === 'function') onAdd(payload);
    }
  }, { signal: sig });

  const onBgSync = () => { if (dlg.open) renderSurahs(); };
  window.addEventListener('sp-bgaudio-sync', onBgSync, { signal: sig });
  dlg.addEventListener('close', () => {
    if (dlg._quranAC === ac) {
      ac.abort();
      dlg._quranAC = null;
    }
  }, { once: true });

  recFilter.value = '';
  surahSearch.value = '';
  renderReciters();
  renderSurahs();
  openDialog(dlg);

  // Lazy-load all 200+ MP3Quran reciters in background without resetting user's focus/scroll
  if (!cachedAllReciters) {
    fetchAllReciters().then((all) => {
      if (!dlg.open || dlg._quranAC !== ac) return;
      reciters = all;
      const keep = selectedReciter ? selectedReciter.id : recSelect.value;
      selectedReciter = reciters.find((r) => r.id === keep) || selectedReciter;
      renderReciters();
    });
  }
}

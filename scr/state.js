const DATA_KEY = 'matem-doska:data:v1';
const SETTINGS_KEY = 'matem-doska:settings:v1';

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

// Три фиксированных предмета. Порядок важен — используется в выпадающих списках.
export const SUBJECTS = ['Алгебра', 'Вероятность и статистика', 'Геометрия'];

function emptyData() {
  return {
    classes: {},        // { "8а": [{id, name}] }
    grades: {},         // { studentId: [{id, value, subject, topic, date}] }
    randomHistory: {},  // { className: [studentId,...] } — уже вызванные в текущем круге
    topics: {},         // { "className::Предмет": "текущая тема урока" }
    spinLog: {},        // { className: [{id, studentId, name, at}] } — полный журнал прокрутов
  };
}

// Старые записи оценок хранили произвольный текст в поле "subject" (это была
// тема/причина, а не предмет). Приводим их к новому формату: subject — один
// из трёх фиксированных предметов, topic — прежний текст-причина.
function migrate(d) {
  for (const sid of Object.keys(d.grades || {})) {
    d.grades[sid] = (d.grades[sid] || []).map(g => {
      if (g.topic !== undefined) return g;
      const wasRealSubject = SUBJECTS.includes(g.subject);
      return {
        ...g,
        topic: wasRealSubject ? '' : (g.subject || ''),
        subject: wasRealSubject ? g.subject : SUBJECTS[0],
      };
    });
  }
  if (!d.topics) d.topics = {};
  if (!d.spinLog) d.spinLog = {};
  return d;
}

// Локальный кэш используется только как подстраховка на случай, если при
// открытии сайта нет связи с облаком — источником истины всегда является
// Supabase (см. src/supabase.js и boot() в main.js).
let data = load();
let settings = loadSettings();

function load() {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (!raw) return emptyData();
    const parsed = JSON.parse(raw);
    return migrate({ ...emptyData(), ...parsed });
  } catch {
    return emptyData();
  }
}

let changeListeners = [];
// opts.remote === true — изменение пришло из облака (первичная загрузка или
// realtime-обновление от другого учителя): нужно перерисовать экран, но НЕ
// нужно снова отправлять эти же данные обратно в облако.
function notify(opts = {}) {
  changeListeners.forEach(fn => {
    try { fn(opts); } catch (err) { console.error(err); }
  });
}

function persist(opts) {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch { /* хранилище недоступно — не критично */ }
  notify(opts);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export const Settings = {
  // Тема оформления — это настройка конкретного устройства/браузера, а не
  // общих данных, поэтому она остаётся только в localStorage.
  get() { return { theme: 'dark', ...settings }; },
  update(patch) {
    settings = { ...settings, ...patch };
    persistSettings();
  },
};

export const Store = {
  // ---------- подписка на изменения (используется для автосинхронизации и рендера) ----------
  onChange(fn) { changeListeners.push(fn); },

  // ---------- экспорт всего состояния (для отправки в облако) ----------
  getSnapshot() { return JSON.parse(JSON.stringify(data)); },

  // Применить данные, пришедшие ИЗ облака (первичная загрузка при входе или
  // обновление в реальном времени от другого учителя). Не запускает
  // повторную отправку этих же данных обратно в облако.
  hydrateFromCloud(snapshot) {
    data = migrate({ ...emptyData(), ...(snapshot || {}) });
    persist({ remote: true });
  },

  // ---------- классы ----------
  getClassNames() {
    return Object.keys(data.classes).sort((a, b) => a.localeCompare(b, 'ru'));
  },
  getStudents(className) {
    return data.classes[className] || [];
  },
  addClass(name) {
    name = name.trim();
    if (!name || data.classes[name]) return false;
    data.classes[name] = [];
    persist();
    return true;
  },
  renameClass(oldName, newName) {
    newName = newName.trim();
    if (!newName || data.classes[newName]) return false;
    data.classes[newName] = data.classes[oldName];
    delete data.classes[oldName];
    if (data.randomHistory[oldName]) {
      data.randomHistory[newName] = data.randomHistory[oldName];
      delete data.randomHistory[oldName];
    }
    if (data.spinLog[oldName]) {
      data.spinLog[newName] = data.spinLog[oldName];
      delete data.spinLog[oldName];
    }
    for (const key of Object.keys(data.topics)) {
      if (key.startsWith(oldName + '::')) {
        data.topics[newName + key.slice(oldName.length)] = data.topics[key];
        delete data.topics[key];
      }
    }
    persist();
    return true;
  },
  removeClass(name) {
    delete data.classes[name];
    delete data.randomHistory[name];
    delete data.spinLog[name];
    for (const key of Object.keys(data.topics)) {
      if (key.startsWith(name + '::')) delete data.topics[key];
    }
    persist();
  },

  // ---------- ученики ----------
  addStudent(className, name) {
    name = name.trim();
    if (!name) return;
    if (!data.classes[className]) data.classes[className] = [];
    data.classes[className].push({ id: uid(), name });
    persist();
  },
  removeStudent(className, studentId) {
    data.classes[className] = (data.classes[className] || []).filter(s => s.id !== studentId);
    delete data.grades[studentId];
    if (data.randomHistory[className]) {
      data.randomHistory[className] = data.randomHistory[className].filter(id => id !== studentId);
    }
    persist();
  },

  // ---------- импорт из Excel ----------
  // sheets: [{ className, names: string[] }]
  importSheets(sheets, mode = 'replace') {
    for (const { className, names } of sheets) {
      const cn = className.trim();
      if (!cn) continue;
      const existing = mode === 'merge' ? (data.classes[cn] || []) : [];
      const existingNames = new Set(existing.map(s => s.name.toLowerCase()));
      const merged = [...existing];
      for (const n of names) {
        const clean = n.trim();
        if (!clean) continue;
        if (existingNames.has(clean.toLowerCase())) continue;
        merged.push({ id: uid(), name: clean });
        existingNames.add(clean.toLowerCase());
      }
      data.classes[cn] = merged;
    }
    persist();
  },

  // ---------- оценки ----------
  getGrades(studentId) {
    // date хранится с точностью до дня (для отображения), поэтому несколько
    // оценок за один день неотличимы по нему. Сортируем по createdAt —
    // точной метке времени постановки — по возрастанию, чтобы оценки шли
    // слева направо в том порядке, в каком реально ставились (сначала
    // самая старая, в конце — самая свежая). У старых оценок (без
    // createdAt) он просто 0 — стабильная сортировка сохранит их исходный
    // порядок в массиве.
    return (data.grades[studentId] || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  },
  // subject — один из SUBJECTS; topic — тема/причина оценки (необязательно).
  addGrade(studentId, value, subject, topic, date) {
    if (!data.grades[studentId]) data.grades[studentId] = [];
    data.grades[studentId].push({
      id: uid(),
      value: Number(value),
      subject: SUBJECTS.includes(subject) ? subject : SUBJECTS[0],
      topic: (topic || '').trim(),
      date: date || new Date().toISOString().slice(0, 10),
      createdAt: Date.now(),
    });
    persist();
  },
  removeGrade(studentId, gradeId) {
    data.grades[studentId] = (data.grades[studentId] || []).filter(g => g.id !== gradeId);
    persist();
  },
  // subject === null/undefined — среднее по всем предметам сразу.
  average(studentId, subject) {
    let gs = data.grades[studentId] || [];
    if (subject) gs = gs.filter(g => g.subject === subject);
    if (!gs.length) return null;
    return gs.reduce((s, g) => s + g.value, 0) / gs.length;
  },
  // Полностью удаляет оценки (по всем предметам) у всех учеников класса.
  clearClassGrades(className) {
    const students = data.classes[className] || [];
    for (const s of students) delete data.grades[s.id];
    persist();
  },

  // ---------- временная тема урока (подставляется в новые оценки) ----------
  getTopic(className, subject) {
    return data.topics[`${className}::${subject}`] || '';
  },
  setTopic(className, subject, text) {
    data.topics[`${className}::${subject}`] = (text || '').trim();
    persist();
  },

  // ---------- рандомайзер ----------
  pickRandom(className, noRepeat = true) {
    const students = data.classes[className] || [];
    if (!students.length) return { student: null };

    let pool = students;
    let cycleReset = false;

    if (noRepeat) {
      const used = new Set(data.randomHistory[className] || []);
      pool = students.filter(s => !used.has(s.id));
      if (!pool.length) {
        pool = students;
        cycleReset = true;
        data.randomHistory[className] = [];
      }
    }

    const chosen = pool[Math.floor(Math.random() * pool.length)];

    if (noRepeat) {
      if (!data.randomHistory[className]) data.randomHistory[className] = [];
      if (cycleReset) data.randomHistory[className] = [];
      data.randomHistory[className].push(chosen.id);
    }

    // Полный журнал нужен отдельно от истории текущего круга: он сохраняет
    // каждый результат рулетки вместе с точной датой и временем.
    if (!data.spinLog[className]) data.spinLog[className] = [];
    data.spinLog[className].push({
      id: uid(), studentId: chosen.id, name: chosen.name, at: new Date().toISOString(),
    });
    persist();

    const used = (data.randomHistory[className] || []).length;
    return { student: chosen, cycleReset, remaining: students.length - used, total: students.length };
  },
  resetHistory(className) {
    data.randomHistory[className] = [];
    persist();
  },
  getHistoryCount(className) {
    return (data.randomHistory[className] || []).length;
  },
  getSpinLog(className) {
    return (data.spinLog[className] || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  },
  clearSpinLog(className) {
    data.spinLog[className] = [];
    persist();
  },
  removeSpinLogEntry(className, entryId) {
    data.spinLog[className] = (data.spinLog[className] || []).filter(x => x.id !== entryId);
    persist();
  },
};

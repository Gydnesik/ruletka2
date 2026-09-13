import { Store, Settings, SUBJECTS } from './state.js';
import { parseFiles } from './xlsx-import.js';
import {
  isConfigured, signIn, signOut, getSession, onAuthStateChange,
  fetchBoardData, subscribeToBoardData, scheduleAutoPush,
} from './supabase.js';

const app = document.getElementById('app');
let booted = false;
let session = null;
let loginError = '';
let loginBusy = false;
let toastQueued = null;

// ---- защита от "вечной загрузки": любая ошибка показывается на экране,
// а не оставляет пользователя смотреть на бесконечный спиннер ----
function showFatalError(err) {
  console.error(err);
  if (booted) return; // приложение уже успешно отрисовалось — не перекрываем его
  const message = err && err.message ? err.message : String(err);
  app.innerHTML = `
    <div style="min-height:100vh;background:#0b0714;color:#f1eafb;padding:32px;font-family:monospace;">
      <h2 style="font-family:sans-serif;">Не получилось загрузить приложение</h2>
      <p>${escapeHtml(message)}</p>
      <p style="opacity:.7;">Откройте консоль браузера (F12 → Console) для подробностей.
      Частая причина — нет интернета для загрузки шрифтов/библиотек при первом запуске, или устаревшая версия открыта из кэша (попробуйте Ctrl+Shift+R).</p>
    </div>
  `;
}
window.addEventListener('error', e => showFatalError(e.error || e.message));
window.addEventListener('unhandledrejection', e => showFatalError(e.reason));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

const ADMIN_EMAIL = 'admin@gdn.com';
const TABS = [
  { id: 'random', label: 'Рандомайзер', ico: '🎯' },
  { id: 'numbers', label: 'Числа', ico: '🔢' },
  { id: 'classes', label: 'Классы', ico: '🗂' },
  { id: 'grades', label: 'Оценки', ico: '📊' },
  { id: 'settings', label: 'Настройки', ico: '⚙️' },
];

function isAdmin() { return (session?.user?.email || '').toLowerCase() === ADMIN_EMAIL; }
function getTabs() { return isAdmin() ? [...TABS, { id: 'spin-log', label: 'История рулетки', ico: '🕘' }] : TABS; }

let state = {
  tab: 'random',
  randomClass: null,
  gradesClass: null,
  gradesStudent: null,
  gradesSubject: 'Все',
  spinning: false,
  randomWithGrade: false,
  randomSubject: SUBJECTS[0],
  randomGradeValue: '5',
  numberMin: 1,
  numberMax: 100,
  numberResult: null,
};

// Любое изменение данных (классы, ученики, оценки), сделанное локально,
// само уходит в общее облачное хранилище — см. src/supabase.js.
// Изменения, пришедшие ИЗ облака (opts.remote), просто перерисовывают экран.
Store.onChange(opts => {
  if (!opts || !opts.remote) {
    // Локальное изменение: экран уже перерисовывается самим обработчиком
    // события, здесь только планируем отправку в облако.
    scheduleAutoPush(Store.getSnapshot);
    return;
  }
  // Изменение пришло из облака (первичная загрузка при входе или
  // realtime-обновление от другого учителя) — перерисовываем экран, если
  // приложение уже показано (иначе перерисует сам boot()).
  if (booted) render();
});

function applyTheme() {
  document.documentElement.setAttribute('data-theme', Settings.get().theme);
}
applyTheme();

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (isError) el.style.borderColor = 'var(--danger)';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ============================================================
// ВХОД
// ============================================================
function renderLogin() {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1>Рулетка доски</h1>
        <p class="hint">Вход только для двух учителей — доступ выдаётся заранее в Supabase.</p>
        <form id="login-form" class="stack">
          <div>
            <label for="login-email">E-mail</label>
            <input type="email" id="login-email" autocomplete="username" required />
          </div>
          <div>
            <label for="login-password">Пароль</label>
            <input type="password" id="login-password" autocomplete="current-password" required />
          </div>
          <button type="submit" class="btn primary" ${loginBusy ? 'disabled' : ''}>${loginBusy ? 'Входим…' : 'Войти'}</button>
          <div class="login-error">${escapeHtml(loginError || '')}</div>
        </form>
      </div>
    </div>
  `;
  booted = true;
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    loginBusy = true;
    loginError = '';
    renderLogin();
    try {
      session = await signIn(email, password);
      await afterLogin();
    } catch (err) {
      loginBusy = false;
      loginError = translateAuthError(err);
      renderLogin();
    }
  });
}

function translateAuthError(err) {
  const msg = (err && err.message) || String(err);
  if (/invalid login credentials/i.test(msg)) return 'Неверный e-mail или пароль.';
  if (/email not confirmed/i.test(msg)) return 'Почта не подтверждена — попросите администратора включить Auto Confirm в Supabase.';
  return msg;
}

function renderBootLoading(text) {
  app.innerHTML = `<div class="boot-loading">${escapeHtml(text)}</div>`;
}

function render() {
  // Пока едет лента рулетки, НИКАКОЙ полный render() выполняться не должен —
  // он полностью пересоздаёт весь DOM (app.innerHTML = ...), а значит стирает
  // и едущую ленту имён посреди анимации. Раньше это могло случиться, например,
  // из-за фонового realtime-обновления от Supabase (даже «эхо» собственного
  // сохранения) — рулетка визуально «зависала» на одном имени, а затем через
  // время результат просто грубо подставлялся без анимации. Сами данные
  // (Store) при этом всё равно обновляются в фоне; просто отрисовку экрана
  // откладываем до конца спина — runSpin() сам вызовет render() ещё раз сразу
  // после того, как выставит state.spinning = false, и на экране появится уже
  // самое актуальное состояние.
  if (state.spinning) return;
  if (!session) { renderLogin(); return; }
  const classNames = Store.getClassNames();
  if (!state.randomClass && classNames.length) state.randomClass = classNames[0];
  if (state.randomClass && !classNames.includes(state.randomClass)) state.randomClass = classNames[0] || null;
  if (!state.gradesClass && classNames.length) state.gradesClass = classNames[0];
  if (state.gradesClass && !classNames.includes(state.gradesClass)) state.gradesClass = classNames[0] || null;

  const visibleTabs = getTabs();
  if (!visibleTabs.some(t => t.id === state.tab)) state.tab = 'random';

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="mark"><span class="mark-pg">PG</span> <span class="mark-title">Рулетка</span></span>
        </div>
        <nav class="nav">
          ${visibleTabs.map(t => `
            <button class="nav-btn ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
              <span class="dot"></span>${t.label}
            </button>
          `).join('')}
        </nav>
        <div class="theme-switch">
          <span>${Settings.get().theme === 'dark' ? 'Тёмная тема' : 'Светлая тема'}</span>
          <button id="theme-toggle">Сменить</button>
        </div>
        <div class="theme-switch">
          <span title="${escapeAttr(session?.user?.email || '')}">${escapeHtml(session?.user?.email || '')}</span>
          <button id="logout-btn">Выйти</button>
        </div>
      </aside>

      <main class="main ${state.tab === 'random' ? 'main-random' : ''} ${state.tab === 'numbers' ? 'main-numbers' : ''}">
        ${renderTab(classNames)}
      </main>

      <nav class="tabbar">
        ${visibleTabs.map(t => `
          <button class="${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
            <span class="ico">${t.ico}</span>${t.label}
          </button>
        `).join('')}
      </nav>
    </div>
  `;

  wireEvents();
  booted = true;
  app.dataset.rendered = '1';
}

function renderTab(classNames) {
  if (state.tab === 'random') return renderRandom(classNames);
  if (state.tab === 'numbers') return renderNumbers();
  if (state.tab === 'classes') return renderClasses(classNames);
  if (state.tab === 'grades') return renderGrades(classNames);
  if (state.tab === 'settings') return renderSettings();
  if (state.tab === 'spin-log' && isAdmin()) return renderSpinLog(classNames);
  return '';
}

// ============================================================
// АДМИН: ПОЛНАЯ ИСТОРИЯ РУЛЕТКИ
// ============================================================
function renderSpinLog(classNames) {
  const selected = state.spinLogClass && classNames.includes(state.spinLogClass) ? state.spinLogClass : classNames[0];
  state.spinLogClass = selected || null;
  if (!classNames.length) return `<div class="panel-header"><h1>История рулетки</h1><p>Классов пока нет.</p></div>`;
  const entries = Store.getSpinLog(selected);
  return `
    <div class="panel-header"><h1>История рулетки</h1><p>Полный журнал выпадений. Доступен только аккаунту администратора.</p></div>
    <div class="spinlog-layout">
      <aside class="spinlog-classes">
        ${classNames.map(c => `<button class="spinlog-class ${c === selected ? 'active' : ''}" data-spinlog-class="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join('')}
      </aside>
      <section class="card spinlog-card">
        <div class="row between"><div><h2>${escapeHtml(selected)}</h2><p class="hint">Слева имя ученика, справа полные дата и время.</p></div><button class="btn danger" id="clear-spinlog-btn">Стереть историю класса</button></div>
        ${entries.length ? `<div class="spinlog-list">${entries.map(x => `<div class="spinlog-row"><div class="spinlog-name">${escapeHtml(x.name)}</div><div class="spinlog-date">${formatFullDate(x.at)}</div><button class="icon-btn" title="Удалить запись" data-remove-spinlog="${escapeAttr(x.id)}">×</button></div>`).join('')}</div>` : '<div class="empty">История прокрутов этого класса пока пуста.</div>'}
      </section>
    </div>`;
}

function formatFullDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(d);
}

// ============================================================
// РАНДОМАЙЗЕР
// ============================================================
function renderRandom(classNames) {
  if (!classNames.length) {
    return `
      <div class="random-stage">
        <div class="panel-header">
          <h1>Рандомайзер</h1>
          <p>Кто выйдет к доске — решает жребий, а не память учителя.</p>
        </div>
        <div class="empty">Сначала добавьте хотя бы один класс со списком учеников — вкладка «Классы».</div>
      </div>
    `;
  }

  const cls = state.randomClass || classNames[0];
  const students = Store.getStudents(cls);
  const used = Store.getHistoryCount(cls);
  if (!SUBJECTS.includes(state.randomSubject)) state.randomSubject = SUBJECTS[0];
  const randomSubject = state.randomSubject;
  const selectedStudent = students.find(s => s.id === state.lastStudentId) || null;
  const currentTopic = selectedStudent ? Store.getTopic(cls, randomSubject) : '';

  return `
    <div class="random-stage">
      <div class="panel-header">
        <h1>Рандомайзер</h1>
        <p>Выберите класс и запустите жеребьёвку — имя выкатится, как мел по доске.</p>
      </div>

      <div class="card random-controls-card">
        <div class="row between">
          <div class="row control-group">
            <label for="random-class">Класс</label>
            <select id="random-class">
              ${classNames.map(c => `<option value="${escapeAttr(c)}" ${c === cls ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
            </select>
          </div>
          <div class="row" style="gap:7px; flex-wrap:wrap;">
            <label class="control-group">
              <input type="checkbox" id="random-with-grade" ${state.randomWithGrade ? 'checked' : ''} />
              <span style="font-size:13px;">С оценками</span>
            </label>
            <label class="control-group">
              <span style="font-size:13px;">Предмет</span>
              <select id="random-subject">
                ${SUBJECTS.map(s => `<option value="${escapeAttr(s)}" ${s === randomSubject ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
              </select>
            </label>
            <label class="control-group control-group--wide">
              <input type="checkbox" id="no-repeat" ${state.noRepeat === false ? '' : 'checked'} />
              <span style="font-size:13px;">Не повторять</span>
            </label>
          </div>
        </div>
      </div>

      <div class="card random-main-card" style="margin-top:16px;">
        <div class="reel-wrap">
          <div class="reel-window ${state.spinning ? 'spinning' : ''} ${state.justLanded ? 'landed' : ''}" id="reel-window">
            <div class="reel-name" id="reel-name">${escapeHtml(state.lastName || (students.length ? 'Готовы?' : 'Нет учеников'))}</div>
          </div>
          <div class="reel-meta">
            ${students.length
              ? `<strong>${used}</strong> / ${students.length} уже вызывались в этом круге`
              : 'Добавьте учеников в этот класс на вкладке «Классы»'}
          </div>
          <div class="row">
            <button class="btn primary" id="spin-btn" ${students.length ? '' : 'disabled'}>Крутить</button>
            <button class="btn ghost" id="reset-history-btn">Сбросить круг</button>
          </div>
          <div class="signature-tag"><span>GYDNESIK x PONAMA</span></div>
        </div>
      </div>

      ${state.randomWithGrade && selectedStudent ? `
        <div class="card random-grade-card ${state.justLanded ? 'random-grade-card--neon' : ''}" style="margin-top:16px;">
          <div class="panel-header" style="margin-bottom:14px;">
            <h2>Поставить оценку</h2>
            <p>Выпал ученик: <strong>${escapeHtml(selectedStudent.name)}</strong> · ${escapeHtml(cls)} · ${escapeHtml(randomSubject)}</p>
          </div>
          <div class="row" style="align-items:flex-end; flex-wrap:wrap; gap:12px;">
            <div>
              <label for="random-grade-value">Оценка</label>
              <select id="random-grade-value">
                ${[2,3,4,5].map(v => `<option value="${v}" ${String(v) === String(state.randomGradeValue) ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </div>
            <div style="flex:1; min-width:220px;">
              <label for="random-grade-topic">Тема</label>
              <input type="text" id="random-grade-topic" value="${escapeAttr(currentTopic)}" placeholder="Текущая тема урока" />
            </div>
            <button class="btn primary" id="random-add-grade">Поставить оценку</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderNumbers() {
  return `
    <div class="numbers-stage">
      <div class="panel-header">
        <h1>Числа</h1>
        <p>Долой Яндекс! Джимини лучше</p>
      </div>

      <div class="card numbers-card">
        <div class="numbers-range">
          <div class="numbers-field">
            <label for="number-min">От</label>
            <input type="number" id="number-min" value="${escapeAttr(state.numberMin)}" inputmode="numeric" />
          </div>
          <div class="numbers-dash">—</div>
          <div class="numbers-field">
            <label for="number-max">До</label>
            <input type="number" id="number-max" value="${escapeAttr(state.numberMax)}" inputmode="numeric" />
          </div>
        </div>

        <button class="btn primary numbers-spin-btn" id="number-spin-btn">Сгенерировать</button>

        <div class="number-result ${state.numberResult !== null ? 'number-result--ready' : ''}" id="number-result" aria-live="polite">
          <span>${state.numberResult !== null ? escapeHtml(state.numberResult) : '—'}</span>
        </div>
      </div>
    </div>
  `;
}

function runNumberRandom() {
  const minInput = document.getElementById('number-min');
  const maxInput = document.getElementById('number-max');
  const min = Number(minInput?.value);
  const max = Number(maxInput?.value);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    toast('Введите оба числа.', true);
    return;
  }
  if (min > max) {
    toast('Число «От» не может быть больше числа «До».', true);
    return;
  }

  state.numberMin = min;
  state.numberMax = max;

  const result = Math.floor(Math.random() * (max - min + 1)) + min;
  const resultEl = document.getElementById('number-result');
  if (!resultEl) return;
  resultEl.classList.remove('number-result--ready');
  void resultEl.offsetWidth;
  resultEl.querySelector('span').textContent = String(result);
  resultEl.classList.add('number-result--ready');
  state.numberResult = result;
}

function runSpin(cls) {
  const students = Store.getStudents(cls);
  if (!students.length || state.spinning) return;
  state.spinning = true;
  state.justLanded = false;

  const reelWindow = document.getElementById('reel-window');
  if (!reelWindow) { state.spinning = false; return; }
  reelWindow.classList.remove('landed');
  reelWindow.classList.add('spinning');

  // Результат известен заранее (в т.ч. чтобы честно учесть историю/«не повторять»),
  // а дальше просто строим ленту карточек так, чтобы победитель приехал под указатель.
  const noRepeat = document.getElementById('no-repeat')?.checked ?? true;
  const result = Store.pickRandom(cls, noRepeat);
  const winner = result.student;

  const ITEMS_BEFORE = 30; // прокрутка слева направо, но в рамках 5-секундного лимита
  const ITEMS_AFTER = 4;   // небольшой запас карточек после победителя, чтобы окно не оказалось пустым

  let prevId = null;
  const pickDecoy = () => {
    let candidate = students[Math.floor(Math.random() * students.length)];
    if (students.length > 1) {
      while (candidate.id === prevId) {
        candidate = students[Math.floor(Math.random() * students.length)];
      }
    }
    prevId = candidate.id;
    return candidate;
  };

  const sequence = [];
  for (let i = 0; i < ITEMS_BEFORE; i++) sequence.push(pickDecoy());
  sequence.push(winner);
  const targetIndex = sequence.length - 1;
  prevId = winner ? winner.id : null;
  for (let i = 0; i < ITEMS_AFTER; i++) sequence.push(pickDecoy());

  reelWindow.innerHTML = `
    <div class="reel-track" id="reel-track">
      ${sequence.map((s, i) => `<div class="reel-item" data-index="${i}"><span>${escapeHtml(s ? s.name : '—')}</span></div>`).join('')}
    </div>
    <div class="reel-fade reel-fade--left"></div>
    <div class="reel-fade reel-fade--right"></div>
    <div class="reel-pointer reel-pointer--top"></div>
    <div class="reel-pointer reel-pointer--bottom"></div>
  `;

  const track = document.getElementById('reel-track');

  const finish = () => {
    reelWindow.classList.remove('spinning');
    reelWindow.classList.add('landed');
    state.spinning = false;
    state.justLanded = true;
    state.lastName = winner ? winner.name : '—';
    state.lastStudentId = winner ? winner.id : null;
    if (result.cycleReset) toast('Все ученики уже выходили — начинаем новый круг.');
    render();
    // Анимация приземления (landPulse/landPop) длится 0.5s и должна
    // проиграться только один раз. render() полностью пересоздаёт DOM,
    // поэтому если state.justLanded останется true, ЛЮБОЙ последующий
    // не связанный со спином рендер (например, эхо от облака) снова
    // добавит класс "landed" на свежий элемент и анимация мигнёт повторно.
    // Сбрасываем флаг сразу после того, как анимация точно закончилась.
    setTimeout(() => { state.justLanded = false; }, 550);
  };

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !track) {
    finish();
    return;
  }

  // Ширину карточки меряем уже отрендеренную (она зависит от адаптивных
  // media-запросов), чтобы указатель всегда точно совпал с центром победителя.
  const firstItem = track.querySelector('.reel-item');
  const itemWidth = firstItem ? firstItem.getBoundingClientRect().width : 168;
  const windowWidth = reelWindow.getBoundingClientRect().width;
  const targetCenter = targetIndex * itemWidth + itemWidth / 2;

  // Интрига: финальная точка приземления гуляет по всей ширине карточки
  // победителя — у случайного разброса есть три явных исхода, чтобы каждый
  // выпадал заметно, а не терялся где-то в общем диапазоне:
  //  - иногда указатель точно по центру карточки;
  //  - иногда — почти на самой границе с соседней карточкой, будто ещё
  //    не решено, кто из двух кандидатов победил (но выигрывает всё равно
  //    тот, кто был выбран заранее — Store.pickRandom выше);
  //  - иногда — где-то посередине этих двух крайностей.
  // Победитель при этом определён заранее и не меняется — гуляет только
  // визуальная точка остановки внутри его карточки.
  const zoneRoll = Math.random();
  let jitterFactor;
  if (zoneRoll < 0.25) {
    jitterFactor = (Math.random() * 2 - 1) * 0.06; // ровно по центру
  } else if (zoneRoll < 0.55) {
    // почти на границе с соседней карточкой (слева или справа)
    const side = Math.random() < 0.5 ? -1 : 1;
    jitterFactor = side * (0.4 + Math.random() * 0.08);
  } else {
    jitterFactor = (Math.random() * 2 - 1) * 0.32; // где-то между центром и краем
  }
  const suspenseJitter = jitterFactor * itemWidth;
  const targetLandingPoint = targetCenter + suspenseJitter;
  const finalOffset = targetLandingPoint - windowWidth / 2;

  // Одна непрерывная анимация без промежуточных «ложных» точек: лента
  // разгоняется, а затем плавно и без рывков в конце тормозит ровно там,
  // где определён finalOffset (то есть в начале/середине/конце карточки —
  // куда именно, решает suspenseJitter выше). Никакого второго "дожима"
  // в другую сторону после видимой остановки — только один непрерывный ход.
  const TOTAL_MS = 4700; // строго меньше 5 секунд

  const anim = track.animate(
    [
      {
        transform: 'translateX(0px)',
        offset: 0,
        easing: 'cubic-bezier(0.1, 0.7, 0.05, 1)', // быстрый разгон, затем долгое плавное торможение — сама тягучесть и есть интрига
      },
      {
        transform: `translateX(-${finalOffset}px)`,
        offset: 1,
      },
    ],
    { duration: TOTAL_MS, fill: 'forwards' }
  );

  // Пауза после остановки ленты — даём глазу увидеть, ГДЕ именно она встала
  // (ровно по центру карточки или ближе к краю), прежде чем свернуть всё
  // в крупное имя. Без этой паузы settle() и finish() срабатывали в один
  // и тот же тик, и итоговый кадр с остановленной лентой ни разу не
  // успевал отрисоваться — отсюда ощущение "она никогда не останавливается".
  const LAND_PAUSE_MS = 550;

  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    anim.cancel(); // фиксируем финальный transform обычным стилем и убираем Web Animations эффект
    track.style.transform = `translateX(-${finalOffset}px)`;
    reelWindow.classList.remove('spinning');
    reelWindow.classList.add('landed');
    setTimeout(finish, LAND_PAUSE_MS);
  };
  anim.onfinish = settle;
  anim.oncancel = () => {}; // settle() сам вызывает cancel — не даём этому случайно триггернуть повторный finish
  // Подстраховка на случай, если событие finish не пришло (свёрнутая вкладка и т.п.)
  setTimeout(settle, TOTAL_MS + 400 + LAND_PAUSE_MS);
}

// ============================================================
// КЛАССЫ
// ============================================================
function renderClasses(classNames) {
  return `
    <div class="panel-header">
      <h1>Классы</h1>
      <p>Загрузите списки из Excel/ODS (можно сразу несколько файлов — по одному на класс) или ведите их вручную.</p>
    </div>

    <div class="card">
      <div class="row between">
        <div class="stack">
          <label>Импорт файлов (.xlsx, .xls, .ods, .csv) — можно выбрать сразу несколько</label>
          <input type="file" id="xlsx-input" accept=".xlsx,.xls,.ods,.csv" multiple />
        </div>
        <label class="row" style="gap:8px;">
          <input type="checkbox" id="merge-mode" />
          <span style="font-size:13px;">Дополнять существующие классы, а не заменять</span>
        </label>
      </div>
      <p class="hint" style="margin-top:12px;">
        Если один файл — один класс (например «8А.ods»), название класса возьмётся из имени файла.
        Если внутри файла несколько листов, название каждого листа станет своим классом.
        Первая строка, если это заголовок или повтор имени класса, пропускается автоматически.
      </p>
    </div>

    <div class="card">
      <div class="row">
        <input type="text" id="new-class-name" placeholder="Например, 7а" style="min-width:160px;" />
        <button class="btn" id="add-class-btn">Добавить класс</button>
      </div>
    </div>

    ${classNames.length ? classNames.map(cls => renderClassCard(cls)).join('') : '<div class="empty">Классов пока нет.</div>'}
  `;
}

function renderClassCard(cls) {
  const students = Store.getStudents(cls);
  return `
    <div class="card" data-class-card="${escapeAttr(cls)}">
      <div class="row between">
        <h3>${escapeHtml(cls)} <span class="pill">${students.length} чел.</span></h3>
        <button class="btn danger" data-remove-class="${escapeAttr(cls)}">Удалить класс</button>
      </div>
      <div class="row" style="margin-top:12px;">
        <input type="text" data-new-student="${escapeAttr(cls)}" placeholder="Фамилия Имя" style="min-width:200px;" />
        <button class="btn" data-add-student="${escapeAttr(cls)}">Добавить ученика</button>
      </div>
      ${students.length ? `
        <div class="table-scroll" style="margin-top:14px;">
          <table>
            <thead><tr><th>Ученик</th><th></th></tr></thead>
            <tbody>
              ${students.map(s => `
                <tr>
                  <td>${escapeHtml(s.name)}</td>
                  <td style="text-align:right;"><button class="btn ghost" data-remove-student="${escapeAttr(cls)}" data-student-id="${escapeAttr(s.id)}">Удалить</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<p class="hint" style="margin-top:12px;">В классе пока нет учеников.</p>'}
    </div>
  `;
}

// ============================================================
// ОЦЕНКИ
// ============================================================
function renderGrades(classNames) {
  if (!classNames.length) {
    return `
      <div class="panel-header"><h1>Оценки</h1></div>
      <div class="empty">Сначала добавьте класс и учеников — вкладка «Классы».</div>
    `;
  }
  const cls = state.gradesClass || classNames[0];
  if (!state.gradesSubject || (state.gradesSubject !== 'Все' && !SUBJECTS.includes(state.gradesSubject))) {
    state.gradesSubject = 'Все';
  }
  const subjectFilter = state.gradesSubject;
  const students = Store.getStudents(cls);
  const topicSubject = subjectFilter === 'Все' ? SUBJECTS[0] : subjectFilter;
  const topicValue = Store.getTopic(cls, topicSubject);

  return `
    <div class="panel-header">
      <h1>Оценки</h1>
      <p>Журнал по каждому ученику: средний балл считается автоматически.</p>
    </div>

    <div class="card">
      <div class="row between">
        <div class="row">
          <label for="grades-class">Класс</label>
          <select id="grades-class">
            ${classNames.map(c => `<option value="${escapeAttr(c)}" ${c === cls ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
          <label for="grades-subject">Предмет</label>
          <select id="grades-subject">
            <option value="Все" ${subjectFilter === 'Все' ? 'selected' : ''}>Все предметы</option>
            ${SUBJECTS.map(s => `<option value="${escapeAttr(s)}" ${subjectFilter === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
        <button class="btn danger" id="clear-class-grades">Стереть оценки у всех в классе</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <label for="lesson-topic">Текущая тема урока — «${escapeHtml(topicSubject)}»</label>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="lesson-topic" placeholder="Например, «Квадратные уравнения»" value="${escapeAttr(topicValue)}" style="min-width:260px; flex:1;" />
        <button class="btn" id="save-topic-btn">Сохранить тему</button>
      </div>
      <p class="hint" style="margin-top:8px;">
        Эта тема сама подставится в новые оценки по предмету «${escapeHtml(topicSubject)}» — если при выставлении
        оценки не вписать свою причину, оценка запомнит текущую тему.
      </p>
    </div>

    ${students.length ? `
      <div class="card" style="margin-top:16px;">
        <div class="table-scroll">
          <table>
            <thead><tr><th>Ученик</th><th>Средний балл</th><th>Оценки</th><th></th></tr></thead>
            <tbody>
              ${students.map(s => renderStudentGradeRow(s, cls, subjectFilter)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : '<div class="empty" style="margin-top:16px;">В этом классе пока нет учеников.</div>'}
  `;
}

function renderStudentGradeRow(s, cls, subjectFilter) {
  const allGrades = Store.getGrades(s.id);
  const grades = subjectFilter === 'Все' ? allGrades : allGrades.filter(g => g.subject === subjectFilter);
  const avg = Store.average(s.id, subjectFilter === 'Все' ? null : subjectFilter);
  const open = state.gradesStudent === s.id;
  const defaultSubject = subjectFilter === 'Все' ? SUBJECTS[0] : subjectFilter;

  return `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${avg !== null ? avg.toFixed(2) : '—'}</td>
      <td>
        <div class="history-list">
          ${grades.slice(0, 8).map(g => `
            <button type="button" class="grade-chip grade-${g.value}" data-view-grade="${escapeAttr(s.id)}" data-grade-ref="${escapeAttr(g.id)}" title="Нажмите — узнать тему">${g.value}</button>
          `).join('') || '<span class="hint">нет оценок</span>'}
        </div>
      </td>
      <td style="text-align:right;">
        <button class="btn ghost" data-toggle-student="${escapeAttr(s.id)}">${open ? 'Свернуть' : 'Открыть'}</button>
      </td>
    </tr>
    ${open ? `
      <tr>
        <td colspan="4">
          <div class="card" style="background:var(--bg-elev-2);">
            <div class="row">
              <label>Новая оценка</label>
              <select data-grade-value="${escapeAttr(s.id)}">
                <option value="5">5</option>
                <option value="4">4</option>
                <option value="3">3</option>
                <option value="2">2</option>
              </select>
              <label>Предмет</label>
              <select data-grade-subject="${escapeAttr(s.id)}">
                ${SUBJECTS.map(sub => `<option value="${escapeAttr(sub)}" ${sub === defaultSubject ? 'selected' : ''}>${escapeHtml(sub)}</option>`).join('')}
              </select>
              <input type="text" data-grade-topic="${escapeAttr(s.id)}" placeholder="Своя тема (иначе — текущая)" style="min-width:180px;" />
              <button class="btn primary" data-add-grade="${escapeAttr(s.id)}">Добавить</button>
            </div>
            ${allGrades.length ? `
              <div class="table-scroll" style="margin-top:12px;">
                <table>
                  <thead><tr><th>Дата</th><th>Оценка</th><th>Предмет</th><th>Тема</th><th></th></tr></thead>
                  <tbody>
                    ${allGrades.map(g => `
                      <tr>
                        <td>${g.date}</td>
                        <td><span class="grade-chip grade-${g.value}">${g.value}</span></td>
                        <td>${escapeHtml(g.subject)}</td>
                        <td>${escapeHtml(g.topic || '—')}</td>
                        <td style="text-align:right;"><button class="btn ghost" data-remove-grade="${escapeAttr(s.id)}" data-grade-id="${escapeAttr(g.id)}">Удалить</button></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : ''}
          </div>
        </td>
      </tr>
    ` : ''}
  `;
}

// ============================================================
// НАСТРОЙКИ
// ============================================================
function renderSettings() {
  const s = Settings.get();
  return `
    <div class="panel-header">
      <h1>Настройки</h1>
      <p>Тема оформления и подключение облака Supabase для резервного хранения списков и оценок.</p>
    </div>

    <div class="card">
      <h3>Оформление</h3>
      <p class="hint" style="margin:8px 0 14px;">Тёмная — неоновый чёрно-фиолетовый; светлая — лист в клетку.</p>
      <div class="row">
        <button class="btn ${s.theme === 'dark' ? 'primary' : ''}" data-set-theme="dark">Тёмная</button>
        <button class="btn ${s.theme === 'light' ? 'primary' : ''}" data-set-theme="light">Светлая</button>
      </div>
    </div>

    <div class="card">
      <h3>Общие данные (Supabase)</h3>
      <p class="hint" style="margin:8px 0 14px;">
        Классы, ученики и оценки — общие для обоих учителей и хранятся в облаке навсегда:
        как только что-то меняется, изменение сразу уходит в базу, а при открытии сайта
        (с любого устройства, под любым из двух аккаунтов) сразу подтягиваются актуальные данные.
        Кнопки «сохранить/загрузить» не нужны.
      </p>
      <p class="hint">${isConfigured() ? 'Подключение к Supabase настроено ✅.' : 'Supabase не настроен — ключи не заданы в config.js.'}</p>
    </div>

    <div class="card">
      <h3>Аккаунт</h3>
      <p class="hint" style="margin:8px 0 14px;">Вы вошли как <strong>${escapeHtml(session?.user?.email || '')}</strong>.</p>
      <button class="btn danger" id="logout-btn-settings">Выйти из аккаунта</button>
    </div>

    <div class="card">
      <h3>О безопасности</h3>
      <p class="hint">
        Вход разрешён только двум заранее созданным учителям — регистрации новых пользователей
        на сайте нет. Без входа никто не может ни прочитать, ни изменить данные (см. README —
        настройка политик доступа в Supabase).
      </p>
    </div>
  `;
}

// ============================================================
// СОБЫТИЯ
// ============================================================
function wireEvents() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      state.lastName = null;
      state.justLanded = false;
      render();
    });
  });

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = Settings.get().theme === 'dark' ? 'light' : 'dark';
    Settings.update({ theme: next });
    applyTheme();
    render();
  });

  // ---- рандомайзер ----
  document.getElementById('random-class')?.addEventListener('change', e => {
    state.randomClass = e.target.value;
    state.lastName = null;
    state.lastStudentId = null;
    state.justLanded = false;
    render();
  });
  document.getElementById('random-with-grade')?.addEventListener('change', e => {
    state.randomWithGrade = e.target.checked;
    state.justLanded = false;
    render();
  });
  document.getElementById('random-subject')?.addEventListener('change', e => {
    state.randomSubject = e.target.value;
    state.justLanded = false;
    render();
  });
  document.getElementById('random-grade-value')?.addEventListener('change', e => {
    state.randomGradeValue = e.target.value;
  });
  document.getElementById('random-add-grade')?.addEventListener('click', () => {
    const student = Store.getStudents(state.randomClass || '').find(s => s.id === state.lastStudentId);
    if (!student) { toast('Сначала прокрутите рандомайзер.', true); return; }
    const value = document.getElementById('random-grade-value')?.value || state.randomGradeValue || '5';
    const customTopic = document.getElementById('random-grade-topic')?.value.trim() || '';
    const topic = customTopic || Store.getTopic(state.randomClass, state.randomSubject);
    Store.addGrade(student.id, value, state.randomSubject, topic);
    toast(`Оценка ${value} поставлена: ${student.name}`);
    render();
  });
  document.getElementById('spin-btn')?.addEventListener('click', () => runSpin(state.randomClass));
  // ---- числа ----
  document.getElementById('number-spin-btn')?.addEventListener('click', runNumberRandom);
  document.getElementById('number-min')?.addEventListener('change', e => {
    const value = Number(e.target.value);
    if (Number.isFinite(value)) state.numberMin = value;
  });
  document.getElementById('number-max')?.addEventListener('change', e => {
    const value = Number(e.target.value);
    if (Number.isFinite(value)) state.numberMax = value;
  });

  document.getElementById('reset-history-btn')?.addEventListener('click', () => {
    Store.resetHistory(state.randomClass);
    toast('Круг сброшен — все снова могут быть вызваны.');
    render();
  });

  // ---- админ: история рулетки ----
  document.querySelectorAll('[data-spinlog-class]').forEach(btn => {
    btn.addEventListener('click', () => { state.spinLogClass = btn.dataset.spinlogClass; render(); });
  });
  document.getElementById('clear-spinlog-btn')?.addEventListener('click', () => {
    if (!confirm(`Стереть всю историю прокрутов класса «${state.spinLogClass}»?`)) return;
    Store.clearSpinLog(state.spinLogClass);
    toast('История класса очищена.');
    render();
  });
  document.querySelectorAll('[data-remove-spinlog]').forEach(btn => {
    btn.addEventListener('click', () => {
      Store.removeSpinLogEntry(state.spinLogClass, btn.dataset.removeSpinlog);
      render();
    });
  });

  // ---- классы ----
  document.getElementById('xlsx-input')?.addEventListener('change', async e => {
    const files = e.target.files;
    if (!files || !files.length) return;
    try {
      const sheets = await parseFiles(files);
      if (!sheets.length) { toast('Не удалось найти учеников в выбранных файлах.', true); return; }
      const merge = document.getElementById('merge-mode').checked;
      Store.importSheets(sheets, merge ? 'merge' : 'replace');
      toast(`Импортировано классов: ${sheets.length}`);
      render();
    } catch (err) {
      console.error(err);
      toast('Ошибка импорта: ' + err.message, true);
    }
  });

  document.getElementById('add-class-btn')?.addEventListener('click', () => {
    const input = document.getElementById('new-class-name');
    if (Store.addClass(input.value)) { render(); } else { toast('Введите новое уникальное название класса.', true); }
  });

  document.querySelectorAll('[data-remove-class]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm(`Удалить класс «${btn.dataset.removeClass}» вместе со всеми учениками и оценками?`)) return;
      Store.removeClass(btn.dataset.removeClass);
      if (state.randomClass === btn.dataset.removeClass) state.randomClass = null;
      if (state.gradesClass === btn.dataset.removeClass) state.gradesClass = null;
      render();
    });
  });

  document.querySelectorAll('[data-add-student]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cls = btn.dataset.addStudent;
      const input = document.querySelector(`[data-new-student="${cssEscape(cls)}"]`);
      Store.addStudent(cls, input.value);
      render();
    });
  });

  document.querySelectorAll('[data-remove-student]').forEach(btn => {
    btn.addEventListener('click', () => {
      Store.removeStudent(btn.dataset.removeStudent, btn.dataset.studentId);
      render();
    });
  });

  // ---- оценки ----
  document.getElementById('grades-class')?.addEventListener('change', e => {
    state.gradesClass = e.target.value;
    state.gradesStudent = null;
    render();
  });
  document.getElementById('grades-subject')?.addEventListener('change', e => {
    state.gradesSubject = e.target.value;
    state.gradesStudent = null;
    render();
  });
  document.getElementById('save-topic-btn')?.addEventListener('click', () => {
    const subject = state.gradesSubject === 'Все' ? SUBJECTS[0] : state.gradesSubject;
    const value = document.getElementById('lesson-topic').value;
    Store.setTopic(state.gradesClass, subject, value);
    toast(value.trim() ? `Тема сохранена: «${value.trim()}»` : 'Тема очищена.');
    render();
  });
  document.getElementById('clear-class-grades')?.addEventListener('click', () => {
    if (!confirm(`Удалить ВСЕ оценки у всех учеников класса «${state.gradesClass}»? Это нельзя отменить.`)) return;
    Store.clearClassGrades(state.gradesClass);
    toast('Оценки класса очищены.');
    render();
  });
  document.querySelectorAll('[data-toggle-student]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.toggleStudent;
      state.gradesStudent = state.gradesStudent === id ? null : id;
      render();
    });
  });
  document.querySelectorAll('[data-view-grade]').forEach(btn => {
    btn.addEventListener('click', () => {
      const grades = Store.getGrades(btn.dataset.viewGrade);
      const g = grades.find(x => x.id === btn.dataset.gradeRef);
      if (!g) return;
      toast(`${g.date} · ${g.subject} · оценка ${g.value} — ${g.topic ? 'тема: ' + g.topic : 'тема не указана'}`);
    });
  });
  document.querySelectorAll('[data-add-grade]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.addGrade;
      const value = document.querySelector(`[data-grade-value="${cssEscape(id)}"]`).value;
      const subject = document.querySelector(`[data-grade-subject="${cssEscape(id)}"]`).value;
      const customTopic = document.querySelector(`[data-grade-topic="${cssEscape(id)}"]`).value.trim();
      const topic = customTopic || Store.getTopic(state.gradesClass, subject);
      Store.addGrade(id, value, subject, topic);
      render();
    });
  });
  document.querySelectorAll('[data-remove-grade]').forEach(btn => {
    btn.addEventListener('click', () => {
      Store.removeGrade(btn.dataset.removeGrade, btn.dataset.gradeId);
      render();
    });
  });

  // ---- настройки ----
  document.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      Settings.update({ theme: btn.dataset.setTheme });
      applyTheme();
      render();
    });
  });
  document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('logout-btn-settings')?.addEventListener('click', handleLogout);
}

async function handleLogout() {
  try {
    await signOut();
  } catch (err) {
    console.warn('Ошибка выхода:', err);
  }
  session = null;
  loginError = '';
  render();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
function cssEscape(str) { return String(str).replace(/["\\]/g, '\\$&'); }

let realtimeStarted = false;

// Вызывается сразу после успешного входа (и при уже активной сессии на
// старте): подтягивает общие данные из облака и включает обновления в
// реальном времени (если второй учитель что-то поменяет — экран обновится
// сам, без перезагрузки страницы).
async function afterLogin() {
  loginBusy = false;
  loginError = '';
  renderBootLoading('Загружаем данные…');
  try {
    const row = await fetchBoardData();
    if (row && row.payload) Store.hydrateFromCloud(row.payload);
  } catch (err) {
    console.error('Не удалось загрузить данные из облака:', err);
    toastQueued = 'Не получилось загрузить данные из облака: ' + (err.message || err);
  }
  render();
  if (toastQueued) { toast(toastQueued, true); toastQueued = null; }

  if (!realtimeStarted) {
    realtimeStarted = true;
    subscribeToBoardData(payload => {
      // Подстраховка от «эха» собственного изменения: supabase.js уже
      // фильтрует по updated_at, но это сравнение строк — при малейшем
      // расхождении в точности временной метки эхо проскочит и вызовет
      // лишний render() (например, повторное мигание анимации рандомайзера).
      // Если пришедшие данные совпадают с уже имеющимися — это точно наше
      // же изменение, перерисовывать нечего.
      if (JSON.stringify(payload) === JSON.stringify(Store.getSnapshot())) return;
      Store.hydrateFromCloud(payload);
    }).catch(err => console.warn('Realtime-подписка не удалась:', err));
  }
}

async function boot() {
  if (!isConfigured()) {
    showFatalError(new Error('Supabase не настроен — впишите ключи в config.js (см. README.md).'));
    return;
  }
  onAuthStateChange(newSession => {
    // Сессия истекла или пользователь вышел в другой вкладке.
    if (!newSession && session) {
      session = null;
      render();
    }
  }).catch(() => {});

  renderBootLoading('Проверяем вход…');
  try {
    session = await getSession();
  } catch (err) {
    console.warn('Не удалось проверить сессию:', err);
    session = null;
  }

  if (!session) {
    render();
    return;
  }
  await afterLogin();
}

boot().catch(showFatalError);

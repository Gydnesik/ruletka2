// Работа с Supabase: авторизация по e-mail/паролю (только для 2 заранее
// созданных учителей — см. README) и облачное хранилище ОДНОЙ общей записи
// со всеми классами/учениками/оценками. Никакого «кода синхронизации» —
// как только человек вошёл, он работает с общими данными напрямую.
//
// Библиотека Supabase грузится с CDN только в момент реального обращения к
// облаку (лениво), а не при старте приложения.

let _clientLibPromise = null;
function loadClientLib() {
  if (!_clientLibPromise) {
    _clientLibPromise = import('https://esm.sh/@supabase/supabase-js@2').catch(err => {
      _clientLibPromise = null;
      throw new Error('Не удалось загрузить библиотеку Supabase (проверьте интернет-соединение): ' + err.message);
    });
  }
  return _clientLibPromise;
}

function fromWindow(name) {
  const v = window[name];
  if (!v) return '';
  if (typeof v === 'string' && v.startsWith('__')) return ''; // незаполненный плейсхолдер из config.js
  return v;
}

// Ключи задаются ТОЛЬКО в config.js — вручную или через секреты GitHub Actions
// при публикации (см. README.md).
export function getConfig() {
  return { url: fromWindow('SUPABASE_URL'), anonKey: fromWindow('SUPABASE_ANON_KEY') };
}

export function isConfigured() {
  const { url, anonKey } = getConfig();
  return Boolean(url && anonKey);
}

let _client = null;
async function getClient() {
  if (_client) return _client;
  const { url, anonKey } = getConfig();
  if (!url || !anonKey) throw new Error('Supabase не настроен — впишите ключи в config.js (см. README)');
  const { createClient } = await loadClientLib();
  _client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return _client;
}

// ============================================================
// АВТОРИЗАЦИЯ
// Публичной регистрации в приложении НЕТ — только вход. Аккаунты (ровно 2,
// по одному на учителя) создаются один раз вручную в панели Supabase.
// Подробная инструкция — в README.md.
// ============================================================
export async function signIn(email, password) {
  const supabase = await getClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const supabase = await getClient();
  await supabase.auth.signOut();
}

export async function getSession() {
  const supabase = await getClient();
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

// cb(session|null) — вызывается при входе, выходе и обновлении токена.
export async function onAuthStateChange(cb) {
  const supabase = await getClient();
  supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

// ============================================================
// ОБЩИЕ ДАННЫЕ (одна строка на всех: классы, ученики, оценки).
// Как только учитель что-то меняет — изменение сразу уходит в облако.
// Как только кто угодно (любой из двух учителей) открывает сайт — данные
// подтягиваются из облака, а не из памяти конкретного устройства.
// ============================================================
const TABLE = 'board_data';
const ROW_ID = 'shared';

export async function fetchBoardData() {
  const supabase = await getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select('payload, updated_at')
    .eq('id', ROW_ID)
    .maybeSingle();
  if (error) throw error;
  return data; // { payload, updated_at } | null, если ещё ничего не сохраняли
}

let lastPushedAt = null;

export async function pushBoardData(payload) {
  const supabase = await getClient();
  const updated_at = new Date().toISOString();
  lastPushedAt = updated_at;
  const { error } = await supabase
    .from(TABLE)
    .upsert({ id: ROW_ID, payload, updated_at }, { onConflict: 'id' });
  if (error) throw error;
}

// Подписка на изменения от ДРУГОГО устройства/учителя в реальном времени.
// Свои собственные записи (эхо от pushBoardData) игнорируются по updated_at.
export async function subscribeToBoardData(onRemoteChange) {
  const supabase = await getClient();
  const channel = supabase
    .channel('board_data_' + ROW_ID)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: TABLE, filter: `id=eq.${ROW_ID}` },
      payload => {
        const row = payload.new;
        if (!row || !row.payload) return;
        if (row.updated_at === lastPushedAt) return; // это наша же запись — эхо
        onRemoteChange(row.payload, row.updated_at);
      }
    )
    .subscribe();
  return channel;
}

// ---------- автосохранение с небольшой задержкой ----------
// Задержка нужна только чтобы не слать запрос на каждую отдельную букву при
// быстром вводе — реального «выбора кода» тут больше нет, всё автоматически.
let pushTimer = null;
export function scheduleAutoPush(getSnapshot) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushBoardData(getSnapshot()).catch(err => {
      console.warn('Не удалось сохранить в облако:', err.message);
    });
  }, 700);
}

// Библиотека грузится с CDN только в момент реального импорта файла (лениво),
// а не при старте приложения — если CDN недоступен, сломается только импорт
// из Excel, а не всё приложение.
let _xlsxPromise = null;
function loadXLSX() {
  if (!_xlsxPromise) {
    _xlsxPromise = import('https://esm.sh/xlsx@0.18.5').catch(err => {
      _xlsxPromise = null;
      throw new Error('Не удалось загрузить библиотеку для чтения Excel/ODS (проверьте интернет-соединение): ' + err.message);
    });
  }
  return _xlsxPromise;
}

const HEADER_WORDS = ['фио', 'фамилия', 'имя', 'ученик', 'ученики', 'класс', 'name', 'student', '№', 'n'];

function isHeaderWord(cell) {
  const v = String(cell || '').trim().toLowerCase();
  return HEADER_WORDS.some(w => v === w || v.startsWith(w));
}

// "Лист1", "Sheet1", "Sheet" и т.п. — типовые автоназвания, а не настоящее имя класса.
function isGenericSheetName(name) {
  return /^(лист|sheet)\s*\d*$/i.test(String(name || '').trim());
}

function baseNameOf(fileName) {
  return String(fileName || '').replace(/\.(xlsx|xls|ods|csv)$/i, '').trim();
}

// Разбирает один файл (.xlsx / .xls / .ods / .csv).
// Возвращает [{ className, names: string[] }] — файл может дать и несколько классов
// (если внутри несколько именованных листов или столбец "Класс").
export async function parseFile(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const fileBase = baseNameOf(file.name);
  const result = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;

    const headerRow = rows[0].map(c => String(c || '').trim().toLowerCase());
    const classColIdx = headerRow.findIndex(c => c === 'класс' || c === 'class');

    if (classColIdx !== -1) {
      // Формат: один лист, столбцы "Класс" + "ФИО"
      const nameColIdx = headerRow.findIndex(c => ['фио', 'фамилия', 'имя', 'ученик', 'name', 'student'].includes(c));
      const byClass = new Map();
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const cls = String(row[classColIdx] || '').trim();
        const nm = String(row[nameColIdx !== -1 ? nameColIdx : (classColIdx === 0 ? 1 : 0)] || '').trim();
        if (!cls || !nm) continue;
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls).push(nm);
      }
      for (const [className, names] of byClass) result.push({ className, names });
      continue;
    }

    // Обычный формат: один столбец с ФИО.
    // Имя класса берём из названия файла, если лист называется типовым "Лист1"/"Sheet1"
    // (как в выгрузках из школьных программ и Excel/ODS по умолчанию).
    // Если у книги несколько содержательно названных листов — каждый лист = свой класс.
    const useFileNameAsClass = wb.SheetNames.length === 1 && isGenericSheetName(sheetName);
    const className = (useFileNameAsClass ? fileBase : sheetName.trim()) || fileBase || sheetName.trim();

    const names = [];
    for (const row of rows) {
      const cell = row.find(c => String(c || '').trim() !== '');
      if (cell === undefined) continue;
      const val = String(cell).trim();
      if (!val) continue;
      if (isHeaderWord(val)) continue;
      // строка вида "8А" в самом начале списка — это заголовок-повтор имени класса, а не ученик
      if (val.toLowerCase() === className.toLowerCase()) continue;
      names.push(val);
    }
    if (names.length) result.push({ className, names });
  }

  return result;
}

// Разбирает сразу несколько файлов (например, 8А.ods, 8Б.ods, 8В.ods) и объединяет результат.
export async function parseFiles(fileList) {
  const files = Array.from(fileList || []);
  const all = [];
  for (const file of files) {
    try {
      const parsed = await parseFile(file);
      all.push(...parsed);
    } catch (err) {
      console.error(`Не удалось разобрать файл "${file.name}":`, err);
      throw new Error(`Файл «${file.name}»: ${err.message || 'не удалось прочитать'}`);
    }
  }
  return all;
}

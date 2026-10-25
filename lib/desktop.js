/**
 * Мост между Next.js-фронтендом и Electron-оболочкой.
 *
 * В десктоп-режиме методы доступны через window.sqlform — его создаёт
 * preload.js (contextBridge → ipcRenderer.invoke → main.js: нативный
 * буфер обмена и диалог сохранения). Если приложение открыто в обычном
 * браузере (например, во время `next dev`), используется graceful-фолбэк:
 * Clipboard API и скачивание файла через <a download>.
 */

function bridge() {
  if (typeof window === "undefined") return null;
  return window?.sqlform ?? null;
}

/** true, если фронтенд запущен внутри десктоп-оболочки Electron */
export function isDesktop() {
  return bridge() !== null;
}

/** Копирование в буфер обмена: сначала нативный (Electron), потом браузерный механизм */
export async function copyText(text) {
  const b = bridge();
  if (b) {
    try {
      const ok = await b.copyText(text);
      if (ok !== false) return true;
    } catch {
      // упадём в браузерный фолбэк
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // последний шанс: скрытая textarea + execCommand (небезопасный контекст)
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Сохранение .sql: в десктопе — нативный диалог Electron (dialog.showSaveDialog),
 * в браузере — скачивание файла через Blob.
 * Возвращает { status: 'saved'|'cancelled'|'downloaded'|'failed', path? }.
 */
export async function saveSqlFile(defaultName, content) {
  const b = bridge();
  if (b) {
    try {
      const result = await b.saveSqlFile(defaultName, content);
      if (result?.status === "saved" || result?.status === "cancelled") {
        return result;
      }
      return { status: "failed" };
    } catch {
      return { status: "failed" };
    }
  }
  try {
    const blob = new Blob([content], { type: "application/sql" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { status: "downloaded" };
  } catch {
    return { status: "failed" };
  }
}

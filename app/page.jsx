"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { emptyRow, validateRows } from "@/lib/columns";
import { renderBatchSQL, SAVE_FILENAME } from "@/lib/template";
import { copyText, isDesktop, saveSqlFile } from "@/lib/desktop";
import DataGrid from "@/components/DataGrid";
import PreviewPanel from "@/components/PreviewPanel";

const LS_STATE = "sqlform.batch.v3";
const MIN_COUNT = 1;
const MAX_COUNT = 500;

function resizeRows(prev, n) {
  const next = prev.slice(0, n);
  while (next.length < n) next.push(emptyRow());
  return next;
}

const clamp = (n) => Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));

export default function Home() {
  const [countStr, setCountStr] = useState("10");
  const [rows, setRows] = useState(() => resizeRows([], 10));
  const [toast, setToast] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const toastTimer = useRef(null);

  const count = clamp(parseInt(countStr, 10) || MIN_COUNT);

  /* --- восстановление состояния после перезапуска --- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const s = JSON.parse(raw);
        const n = clamp(parseInt(s.limit, 10) || MIN_COUNT);
        if (Array.isArray(s.rows)) {
          setRows(resizeRows(s.rows, n));
          setCountStr(String(n));
        }
      }
    } catch {
      /* повреждённое состояние игнорируем */
    }
    setDesktop(isDesktop());
    setLoaded(true);
  }, []);

  /* --- автосохранение (с дебаунсом) --- */
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(LS_STATE, JSON.stringify({ limit: count, rows }));
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [loaded, count, rows]);

  /* --- изменение количества → ресайз таблицы с сохранением введённого --- */
  const applyCount = useCallback((n) => {
    const c = clamp(n);
    setCountStr(String(c));
    setRows((prev) => resizeRows(prev, c));
  }, []);

  const setCell = useCallback((i, key, value) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }, []);

  /* --- мгновенный предпросмотр: генерация полностью на клиенте --- */
  const sql = renderBatchSQL(rows);
  const errors = validateRows(rows);

  /* --- тосты --- */
  const showToast = useCallback((text, kind = "ok") => {
    setToast({ text, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await copyText(sql);
    showToast(
      ok ? "SQL скопирован в буфер обмена" : "Не удалось скопировать — выделите текст вручную",
      ok ? "ok" : "err",
    );
  }, [sql, showToast]);

  const onSave = useCallback(async () => {
    const outcome = await saveSqlFile(SAVE_FILENAME, sql);
    switch (outcome.status) {
      case "saved":
        showToast(`Файл сохранён: ${outcome.path}`);
        break;
      case "downloaded":
        showToast(`Файл ${SAVE_FILENAME} отправлен в загрузки`);
        break;
      case "cancelled":
        showToast("Сохранение отменено");
        break;
      default:
        showToast("Не удалось сохранить файл", "err");
    }
  }, [sql, showToast]);

  return (
    <div className="app-shell">
      <main className="grid">
        <section className="col" aria-label="Данные займов">
          <div className="card">
            <div className="card-head">
              <h2>Займов к обработке</h2>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setRows(resizeRows([], count))}
              >
                Очистить таблицу
              </button>
            </div>
            <div className="count-row">
              <button
                className="btn btn-step"
                onClick={() => applyCount(count - 1)}
                disabled={count <= MIN_COUNT}
                aria-label="Убавить"
              >
                −
              </button>
              <input
                className="input count-input"
                type="number"
                min={MIN_COUNT}
                max={MAX_COUNT}
                value={countStr}
                onChange={(e) => applyCount(parseInt(e.target.value, 10) || MIN_COUNT)}
                onBlur={(e) => setCountStr(String(clamp(parseInt(e.target.value, 10) || MIN_COUNT)))}
                aria-label="Количество займов"
              />
              <button
                className="btn btn-step"
                onClick={() => applyCount(count + 1)}
                disabled={count >= MAX_COUNT}
                aria-label="Прибавить"
              >
                +
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Данные</h2>
              <span className="stat">{rows.length} строк</span>
            </div>
            <DataGrid rows={rows} onCellChange={setCell} />
          </div>
        </section>

        <section className="col col-preview" aria-label="Предпросмотр SQL">
          <PreviewPanel
            sql={sql}
            errors={errors}
            rowCount={rows.length}
            onCopy={onCopy}
            onSave={onSave}
          />
        </section>
      </main>
      {toast && (
        <div className={`toast ${toast.kind === "err" ? "toast-err" : ""}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

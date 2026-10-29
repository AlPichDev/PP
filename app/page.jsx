"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  renderBatchSQL,
  validateForm,
  effectiveForm,
  normalizeRows,
  countPackageRows,
  SAVE_FILENAME,
  DEFAULT_LIMIT,
  MIN_LIMIT,
  MAX_LIMIT,
  EMPTY_ROW,
} from "@/lib/template";
import { copyText, isDesktop, saveSqlFile } from "@/lib/desktop";
import PreviewPanel from "@/components/PreviewPanel";

const LS_STATE = "sqlform.auto.v5";
const LS_STATE_V4 = "sqlform.auto.v4"; // миграция старой однострочной формы

const INT_RE = /^\d+$/;
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
const normNum = (v) => String(v ?? "").trim().replace(",", ".");

const clampLimit = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return MIN_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
};

export default function Home() {
  const [form, setForm] = useState({ limit: String(DEFAULT_LIMIT), rows: [] });
  const [toast, setToast] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const toastTimer = useRef(null);

  /* --- восстановление состояния после перезапуска (с миграцией v4) --- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const s = JSON.parse(raw);
        setForm({
          limit: s.limit != null ? String(s.limit) : String(DEFAULT_LIMIT),
          rows: Array.isArray(s.rows) ? normalizeRows(s.rows) : [],
        });
      } else {
        // старая форма (одно значение на пакет) → первая строка новой
        const raw4 = localStorage.getItem(LS_STATE_V4);
        if (raw4) {
          const s4 = JSON.parse(raw4);
          setForm({
            limit: s4.limit != null ? String(s4.limit) : String(DEFAULT_LIMIT),
            rows: [
              {
                ekpId: s4.ekpId != null ? String(s4.ekpId) : "",
                loanAmount:
                  s4.overdueLoanAmount != null ? String(s4.overdueLoanAmount) : "",
                interestAmount:
                  s4.overdueInterestAmount != null
                    ? String(s4.overdueInterestAmount)
                    : "",
              },
            ],
          });
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
        localStorage.setItem(LS_STATE, JSON.stringify(form));
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [loaded, form]);

  const setField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  /* --- редактирование строки пакета --- */
  const setRow = useCallback((idx, field, value) => {
    setForm((prev) => {
      const rows = prev.rows.slice();
      while (rows.length <= idx) rows.push({ ...EMPTY_ROW });
      rows[idx] = { ...rows[idx], [field]: value };
      return { ...prev, rows };
    });
  }, []);

  /* --- мгновенный предпросмотр: генерация полностью на клиенте --- */
  const sql = useMemo(() => renderBatchSQL(form), [form]);
  const errors = useMemo(() => validateForm(form), [form]);
  const eff = useMemo(() => effectiveForm(form), [form]);
  const inPackage = useMemo(() => countPackageRows(form), [form]);

  /* --- видимые строки: ровно eff.limit штук (недостающие — пустые) --- */
  const visibleRows = useMemo(() => {
    const out = [];
    for (let i = 0; i < eff.limit; i++) out.push(eff.rows[i] ?? EMPTY_ROW);
    return out;
  }, [eff]);

  /* --- подсветка некорректных полей --- */
  const limitStr = String(form.limit ?? "").trim();
  const limitOk =
    limitStr !== "" && INT_RE.test(limitStr) &&
    Number(limitStr) >= MIN_LIMIT && Number(limitStr) <= MAX_LIMIT;

  const rowStates = useMemo(
    () =>
      visibleRows.map((row) => ({
        ekpOk: row.ekpId !== "" && INT_RE.test(row.ekpId),
        loanOk: row.loanAmount === "" || NUM_RE.test(row.loanAmount),
        intrOk: row.interestAmount === "" || NUM_RE.test(row.interestAmount),
      })),
    [visibleRows],
  );

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

  const onFillAll = useCallback(() => {
    setForm((prev) => {
      const first = prev.rows[0];
      if (!first) return prev;
      const n = clampLimit(prev.limit);
      const rows = [];
      for (let i = 0; i < Math.max(n, prev.rows.length); i++) {
        rows.push({ ...first });
      }
      return { ...prev, rows };
    });
    showToast("Значения первой строки применены ко всем строкам");
  }, [showToast]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>
          SQL Form
          <span className="badge">PostgreSQL</span>
          {loaded && (
            <span className={`badge ${desktop ? "" : "badge-ghost"}`}>
              {desktop ? "Десктоп · Electron" : "Браузер · фолбэк"}
            </span>
          )}
        </h1>
        <p className="subtitle">
          Скрипт сам отбирает договоры из loan_life_cycle (info_status_id = 11,
          life_stage_id = 3, assignment_reason = 7, EKPLA…, минуя revocation_loans)
          с LIMIT из формы — а значения (ЕКП и суммы просрочки) задаются построчно:
          строка № i применяется к i-му отобранному договору. Далее 8 UPDATE-ов
          и контрольные SELECT * по всем затрагиваемым таблицам; счёт (20 симв.)
          и ucp_id (19 симв.) корректируются по длине
        </p>
      </header>

      <main className="grid">
        <section className="col" aria-label="Параметры пакета">
          <div className="card">
            <div className="card-head">
              <h2>Отбор договоров</h2>
              <span className="stat">авто-подбор по критериям</span>
            </div>
            <div className="count-row">
              <button
                className="btn btn-step"
                onClick={() => setField("limit", String(clampLimit(eff.limit - 1)))}
                disabled={eff.limit <= MIN_LIMIT}
                aria-label="Убавить"
              >
                −
              </button>
              <input
                className={`input count-input ${limitOk ? "" : "invalid"}`}
                type="number"
                min={MIN_LIMIT}
                max={MAX_LIMIT}
                value={form.limit}
                onChange={(e) => setField("limit", e.target.value)}
                onBlur={(e) => setField("limit", String(clampLimit(e.target.value)))}
                aria-label="Количество договоров (LIMIT)"
              />
              <button
                className="btn btn-step"
                onClick={() => setField("limit", String(clampLimit(eff.limit + 1)))}
                disabled={eff.limit >= MAX_LIMIT}
                aria-label="Прибавить"
              >
                +
              </button>
              <span className="hint">
                сколько договоров выбрать (LIMIT, 1–{MAX_LIMIT}) — по строке
                значений на каждый договор
              </span>
            </div>
            <ul className="crit-list" aria-label="Критерии отбора">
              <li>loan_life_cycle.is_deleted IS NOT NULL</li>
              <li>info_status_id = 11 · life_stage_id = 3 · assignment_reason = 7</li>
              <li>ext_ref_a LIKE &apos;EKPLA%&apos;</li>
              <li>ext_ref_a NOT IN (SELECT ext_ref_a FROM revocation_loans)</li>
            </ul>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Значения для обновления</h2>
              <span className="stat">по строке на каждый договор</span>
            </div>

            <div className="rows-wrap">
              <table className="rows-table">
                <thead>
                  <tr>
                    <th className="th-num">№</th>
                    <th>
                      Новый ЕКП <code>loan.ekp_id</code>
                    </th>
                    <th>
                      Тело <code>overdue_loan_amount</code>
                    </th>
                    <th>
                      Проценты <code>overdue_interest_amount</code>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, i) => {
                    const st = rowStates[i];
                    return (
                      <tr key={i}>
                        <td className="row-num">{i + 1}</td>
                        <td>
                          <input
                            className={`cell-input ${st.ekpOk ? "" : "invalid"}`}
                            type="text"
                            inputMode="numeric"
                            placeholder="напр. 9001"
                            value={row.ekpId}
                            onChange={(e) => setRow(i, "ekpId", e.target.value)}
                            aria-label={`Строка ${i + 1}: новый ЕКП`}
                          />
                        </td>
                        <td>
                          <input
                            className={`cell-input ${st.loanOk ? "" : "invalid"}`}
                            type="text"
                            inputMode="decimal"
                            placeholder="прим - 1000000.00"
                            value={row.loanAmount}
                            onChange={(e) => setRow(i, "loanAmount", e.target.value)}
                            aria-label={`Строка ${i + 1}: просрочка по телу`}
                          />
                        </td>
                        <td>
                          <input
                            className={`cell-input ${st.intrOk ? "" : "invalid"}`}
                            type="text"
                            inputMode="decimal"
                            placeholder="прим - 100.00"
                            value={row.interestAmount}
                            onChange={(e) => setRow(i, "interestAmount", e.target.value)}
                            aria-label={`Строка ${i + 1}: просрочка по процентам`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="rows-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={onFillAll}
                disabled={eff.limit < 2 || !eff.rows[0]}
                title="Скопировать значения первой строки во все строки пакета"
              >
                Применить первую строку ко всем
              </button>
            </div>

            <p className="hint">
              Строка № i применяется к i-му отобранному договору (порядок отбора —
              по ext_ref_a). Пустая сумма — «не менять» (COALESCE оставит старое
              значение в БД), запятая нормализуется к точке. Строка без ЕКП
              исключается из пакета — договор не попадёт в обновление
            </p>
          </div>
        </section>

        <section className="col col-preview" aria-label="Предпросмотр SQL">
          <PreviewPanel
            sql={sql}
            errors={errors}
            limit={eff.limit}
            rowsInPackage={inPackage}
            onCopy={onCopy}
            onSave={onSave}
          />
        </section>
      </main>

      <footer className="app-footer">
        Electron + Next.js · генерация на клиенте · построчные значения пакета ·
        отсечение договоров revocation_loans и корректировка длин выполняются
        внутри скрипта
      </footer>

      {toast && (
        <div className={`toast ${toast.kind === "err" ? "toast-err" : ""}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

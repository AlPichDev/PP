"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  renderBatchSQL,
  validateForm,
  effectiveForm,
  SAVE_FILENAME,
  DEFAULT_LIMIT,
  MIN_LIMIT,
  MAX_LIMIT,
} from "@/lib/template";
import { copyText, isDesktop, saveSqlFile } from "@/lib/desktop";
import PreviewPanel from "@/components/PreviewPanel";

const LS_STATE = "sqlform.auto.v4";

const EMPTY_FORM = {
  limit: String(DEFAULT_LIMIT),
  ekpId: "",
  overdueLoanAmount: "",
  overdueInterestAmount: "",
};

const INT_RE = /^\d+$/;
const NUM_RE = /^-?\d+(?:\.\d+)?$/;
const normNum = (v) => String(v ?? "").trim().replace(",", ".");

const clampLimit = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return MIN_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
};

export default function Home() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [toast, setToast] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const toastTimer = useRef(null);

  /* --- восстановление состояния после перезапуска --- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const s = JSON.parse(raw);
        setForm((prev) => ({
          limit: s.limit != null ? String(s.limit) : prev.limit,
          ekpId: s.ekpId != null ? String(s.ekpId) : prev.ekpId,
          overdueLoanAmount:
            s.overdueLoanAmount != null ? String(s.overdueLoanAmount) : prev.overdueLoanAmount,
          overdueInterestAmount:
            s.overdueInterestAmount != null
              ? String(s.overdueInterestAmount)
              : prev.overdueInterestAmount,
        }));
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

  /* --- мгновенный предпросмотр: генерация полностью на клиенте --- */
  const sql = renderBatchSQL(form);
  const errors = validateForm(form);
  const eff = effectiveForm(form);

  /* --- подсветка некорректных полей --- */
  const limitStr = String(form.limit ?? "").trim();
  const limitOk =
    limitStr !== "" && INT_RE.test(limitStr) &&
    Number(limitStr) >= MIN_LIMIT && Number(limitStr) <= MAX_LIMIT;
  const ekpStr = String(form.ekpId ?? "").trim();
  const ekpOk = ekpStr !== "" && INT_RE.test(ekpStr);
  const loanOk =
    normNum(form.overdueLoanAmount) === "" ||
    NUM_RE.test(normNum(form.overdueLoanAmount));
  const intrOk =
    normNum(form.overdueInterestAmount) === "" ||
    NUM_RE.test(normNum(form.overdueInterestAmount));

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
          с LIMIT из формы — ручной ввод ext_ref_a больше не нужен. Далее
          8 UPDATE-ов и контрольные SELECT * по всем затрагиваемым таблицам;
          счёт (20 симв.) и ucp_id (19 симв.) корректируются по длине
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
              <span className="hint">сколько договоров выбрать (LIMIT, 1–{MAX_LIMIT})</span>
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
              <span className="stat">одно значение на весь пакет</span>
            </div>

            <div className="field-row">
              <label className="field-label" htmlFor="f-ekp">
                Новый ЕКП — <code>loan.ekp_id</code>
              </label>
              <input
                id="f-ekp"
                className={`field-input ${ekpOk ? "" : "invalid"}`}
                type="text"
                inputMode="numeric"
                placeholder="напр. 9001"
                value={form.ekpId}
                onChange={(e) => setField("ekpId", e.target.value)}
              />
            </div>

            <div className="field-row">
              <label className="field-label" htmlFor="f-loan">
                Просрочка по телу — <code>overdue_loan_amount</code>
              </label>
              <input
                id="f-loan"
                className={`field-input ${loanOk ? "" : "invalid"}`}
                type="text"
                inputMode="decimal"
                placeholder="пусто — не менять, напр. 1500,50"
                value={form.overdueLoanAmount}
                onChange={(e) => setField("overdueLoanAmount", e.target.value)}
              />
            </div>

            <div className="field-row">
              <label className="field-label" htmlFor="f-intr">
                Просрочка по процентам — <code>overdue_interest_amount</code>
              </label>
              <input
                id="f-intr"
                className={`field-input ${intrOk ? "" : "invalid"}`}
                type="text"
                inputMode="decimal"
                placeholder="пусто — не менять, напр. 250,50"
                value={form.overdueInterestAmount}
                onChange={(e) => setField("overdueInterestAmount", e.target.value)}
              />
            </div>

            <p className="hint">
              Суммы применяются ко всем отобранным договорам; пустое поле —
              «не менять» (COALESCE оставит старое значение в БД), запятая
              нормализуется к точке
            </p>
          </div>
        </section>

        <section className="col col-preview" aria-label="Предпросмотр SQL">
          <PreviewPanel
            sql={sql}
            errors={errors}
            limit={eff.limit}
            onCopy={onCopy}
            onSave={onSave}
          />
        </section>
      </main>

      <footer className="app-footer">
        Electron + Next.js · генерация на клиенте · отсечение договоров
        revocation_loans и корректировка длин выполняются внутри скрипта
      </footer>

      {toast && (
        <div className={`toast ${toast.kind === "err" ? "toast-err" : ""}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

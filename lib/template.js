/**
 * Встроенный SQL-скрипт пакетного обновления (PostgreSQL).
 *
 * ГЛАВНОЕ ОТЛИЧИЕ ВЕРСИИ: договоры больше НЕ вводятся вручную.
 * Вместо ручного заполнения ext_ref_a скрипт сам отбирает договоры
 * из loan_life_cycle по критериям ручного алгоритма:
 *
 *     select ext_ref_a
 *     from loan_life_cycle llc
 *     where is_deleted is not null
 *       and info_status_id = 11
 *       and life_stage_id = 3
 *       and assignment_reason = 7
 *       and ext_ref_a LIKE 'EKPLA%'
 *       and ext_ref_a not in (select ext_ref_a from revocation_loans rl)
 *     limit N  -- динамический LIMIT, приходит из формы
 *
 * Форма задаёт 4 параметра: LIMIT (сколько договоров взять), новый
 * ЕКП (loan.ekp_id) и две необязательные суммы просрочки (пусто =
 * «не трогать», работают через COALESCE как раньше).
 *
 * Структура скрипта: TEMP-таблица batch_input (наполняется
 * INSERT ... SELECT с LIMIT) → 2 контрольные SELECT-проверки →
 * восемь отдельных UPDATE (включая два корректировщика длин
 * sberbank_account_number = 20 и client.ucp_id = 19 символов,
 * LEFT(RPAD(...))) → контрольные SELECT * по всем затрагиваемым
 * таблицам (loan, loan_agreement, loan_debt, loan_debt_fix,
 * loan_life_cycle, relationship_client_loan, client,
 * revocation_loans, loan_cession) вместо старых сводных SELECT-ов →
 * COMMIT.
 *
 * Фиксированные значения (life_stage_id = 3, debt_type_code = 9,
 * is_deleted = TRUE, is_recalculated = TRUE, списки зануления)
 * зашиты в шаблон ниже — при изменении алгоритма правьте их здесь.
 */

export const SAVE_FILENAME = "batch_loans_updates.sql";

/* ---------- Ограничения формы ---------- */

export const MIN_LIMIT = 1;
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 10;

/* ---------- Парсинг значений формы ---------- */

const INT_RE = /^\d+$/;
const NUM_RE = /^-?\d+(?:\.\d+)?$/;

/** запятая в дробях нормализуется к точке */
const normNum = (v) => String(v ?? "").trim().replace(",", ".");

const clampLimit = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
};

/** Целое из формы → SQL-литерал (пусто/некорректно → NULL) */
const intLit = (v) => {
  const s = String(v ?? "").trim();
  return INT_RE.test(s) ? `${s}::bigint` : "NULL::bigint";
};

/** Число из формы → SQL-литерал (пусто/некорректно → NULL = «не трогать») */
const numLit = (v) => {
  const s = normNum(v);
  return NUM_RE.test(s) ? `${s}::numeric` : "NULL::numeric";
};

/** Человекочитаемое значение для шапки скрипта */
const humanNum = (v) => {
  const s = normNum(v);
  return NUM_RE.test(s) ? s : "не трогаем";
};

/**
 * Валидация полей формы → массив текстов ошибок.
 * state: { limit, ekpId, overdueLoanAmount, overdueInterestAmount }
 */
export function validateForm(state = {}) {
  const errors = [];

  const limit = String(state.limit ?? "").trim();
  if (limit === "") {
    errors.push("Укажите количество договоров (LIMIT)");
  } else if (!INT_RE.test(limit)) {
    errors.push("LIMIT — целое число");
  } else if (Number(limit) < MIN_LIMIT || Number(limit) > MAX_LIMIT) {
    errors.push(`LIMIT — от ${MIN_LIMIT} до ${MAX_LIMIT}`);
  }

  const ekp = String(state.ekpId ?? "").trim();
  if (ekp === "") {
    errors.push("Не заполнен новый ЕКП (loan.ekp_id)");
  } else if (!INT_RE.test(ekp)) {
    errors.push("Новый ЕКП (loan.ekp_id) — целое число");
  }

  const loanAmt = normNum(state.overdueLoanAmount);
  if (loanAmt !== "" && !NUM_RE.test(loanAmt)) {
    errors.push(
      "Просрочка по телу (overdue_loan_amount) — число (запятая заменится на точку)",
    );
  }

  const intrAmt = normNum(state.overdueInterestAmount);
  if (intrAmt !== "" && !NUM_RE.test(intrAmt)) {
    errors.push(
      "Просрочка по процентам (overdue_interest_amount) — число (запятая заменится на точку)",
    );
  }

  return errors;
}

/** Значения формы, приведённые к «эффективным» величинам для UI */
export function effectiveForm(state = {}) {
  return {
    limit: clampLimit(state.limit),
    ekpId: String(state.ekpId ?? "").trim(),
    overdueLoanAmount: normNum(state.overdueLoanAmount),
    overdueInterestAmount: normNum(state.overdueInterestAmount),
  };
}

/* ---------- Шаблон скрипта ---------- */

export function renderBatchSQL(state = {}) {
  const limit = clampLimit(state.limit);
  const ekpRaw = String(state.ekpId ?? "").trim();
  const ekpLit = intLit(ekpRaw);
  const loanAmtLit = numLit(state.overdueLoanAmount);
  const intrAmtLit = numLit(state.overdueInterestAmount);

  const ekpHuman = INT_RE.test(ekpRaw) ? ekpRaw : "НЕ ЗАПОЛНЕН (ошибка!)";
  const loanHuman = humanNum(state.overdueLoanAmount);
  const intrHuman = humanNum(state.overdueInterestAmount);

  return `-- ============================================================
-- SQL Form · пакетное обновление договоров (PostgreSQL)
-- ------------------------------------------------------------
-- Договоры отбираются автоматически — вместо ручного заполнения
-- ext_ref_a. Критерии отбора (loan_life_cycle):
--   is_deleted IS NOT NULL, info_status_id = 11, life_stage_id = 3,
--   assignment_reason = 7, ext_ref_a LIKE 'EKPLA%', договор ещё
--   не входит в revocation_loans.
--
-- Параметры из формы:
--   LIMIT (сколько договоров) ................ ${limit}
--   Новый ЕКП (loan.ekp_id) .................. ${ekpHuman}
--   Просрочка по телу ........................ ${loanHuman}
--   Просрочка по процентам ................... ${intrHuman}
--
-- Порядок: TEMP-таблица batch_input → 2 контрольные проверки →
-- восемь отдельных UPDATE → контрольные SELECT * по всем
-- затрагиваемым таблицам → COMMIT.
-- ============================================================

BEGIN;

-- 1. Отбор договоров вместо ручного заполнения ext_ref_a.
--    LIMIT ${limit} — из формы. DISTINCT страхует от повторов в
--    loan_life_cycle, ORDER BY делает выборку LIMIT детерминированной,
--    а фильтр IS NOT NULL в подзапросе — классическая защита от ловушки
--    «NOT IN + NULL», когда подзапрос молча опустошает весь отбор.
CREATE TEMP TABLE batch_input (
    ext_ref_a               text,
    new_ekp_id              bigint,
    overdue_loan_amount     numeric,
    overdue_interest_amount numeric
) ON COMMIT DROP;

INSERT INTO batch_input (ext_ref_a, new_ekp_id, overdue_loan_amount, overdue_interest_amount)
SELECT DISTINCT
       llc.ext_ref_a,
       ${ekpLit}  AS new_ekp_id,
       ${loanAmtLit} AS overdue_loan_amount,
       ${intrAmtLit} AS overdue_interest_amount
FROM loan_life_cycle llc
WHERE llc.is_deleted IS NOT NULL
  AND llc.info_status_id = 11
  AND llc.life_stage_id = 3
  AND llc.assignment_reason = 7
  AND llc.ext_ref_a LIKE 'EKPLA%'
  AND llc.ext_ref_a NOT IN (
        SELECT rl.ext_ref_a
        FROM revocation_loans rl
        WHERE rl.ext_ref_a IS NOT NULL
  )
ORDER BY llc.ext_ref_a
LIMIT ${limit};

-- ============================================================
-- КОНТРОЛЬНЫЕ ПРОВЕРКИ (аналог ручных проверок в DBeaver).
-- Каждая должна вернуть 0 строк. Если строки есть — ROLLBACK.
-- ============================================================

-- Проверка 1: все отобранные ext_ref_a найдены в loan
SELECT b.ext_ref_a AS missing_ext_ref_a
FROM batch_input b
LEFT JOIN loan l ON l.ext_ref_a = b.ext_ref_a
WHERE l.id IS NULL;

-- Проверка 2: loan.is_deleted не должен быть TRUE
SELECT l.ext_ref_a, l.ekp_id, l.is_deleted
FROM loan l
JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a
WHERE l.is_deleted;

-- ============================================================
-- ИЗМЕНЕНИЯ: каждая таблица обновляется отдельным UPDATE
-- ============================================================

-- 1. loan: ekp_id заменяется на новый, pprb_tkp_id затирается
UPDATE loan l
SET ekp_id      = b.new_ekp_id,
    pprb_tkp_id = NULL
FROM batch_input b
WHERE l.ext_ref_a = b.ext_ref_a;

-- 2. loan_life_cycle: life_stage_id = 3, portfolio_id и cession_part_id затираются
UPDATE loan_life_cycle llc
SET life_stage_id   = 3,
    portfolio_id    = NULL,
    cession_part_id = NULL
FROM batch_input b
WHERE llc.ext_ref_a = b.ext_ref_a;

-- 3. loan_debt: суммы просрочки; total_amount = overdue_loan_amount + overdue_interest_amount
UPDATE loan_debt ld
SET overdue_loan_amount     = COALESCE(b.overdue_loan_amount, ld.overdue_loan_amount),
    overdue_interest_amount = COALESCE(b.overdue_interest_amount, ld.overdue_interest_amount),
    total_amount            = CASE
                                  WHEN b.overdue_loan_amount IS NOT NULL
                                    OR b.overdue_interest_amount IS NOT NULL
                                  THEN COALESCE(b.overdue_loan_amount, ld.overdue_loan_amount, 0)
                                     + COALESCE(b.overdue_interest_amount, ld.overdue_interest_amount, 0)
                                  ELSE ld.total_amount
                              END
FROM batch_input b
WHERE ld.loan_id IN (SELECT l.id FROM loan l WHERE l.ext_ref_a = b.ext_ref_a);

-- 4. loan_agreement: debt_type_code = 9
UPDATE loan_agreement la
SET debt_type_code = 9
FROM batch_input b
WHERE la.loan_id IN (SELECT l.id FROM loan l WHERE l.ext_ref_a = b.ext_ref_a);

-- 5. Корректировщик sberbank_account_number: значение приводится к 20 символам.
--    Короче 20 — в конце дописываются нули, длиннее 20 — стирается с конца
--    до 20 символов, ровно 20 — не трогается (NULL тоже не изменяется).
UPDATE loan_agreement la
SET sberbank_account_number = LEFT(RPAD(la.sberbank_account_number, 20, '0'), 20)
FROM batch_input b
WHERE la.loan_id IN (SELECT l.id FROM loan l WHERE l.ext_ref_a = b.ext_ref_a)
  AND length(la.sberbank_account_number) <> 20;

-- 6. Корректировщик client.ucp_id: то же правило, длина 19 символов.
--    Клиент находится по цепочке loan.ext_ref_a → relationship_client_loan.ext_ref_c
UPDATE client c
SET ucp_id = LEFT(RPAD(c.ucp_id, 19, '0'), 19)
FROM relationship_client_loan rcl
JOIN batch_input b ON rcl.ext_ref_a = b.ext_ref_a
WHERE c.ext_ref_c = rcl.ext_ref_c
  AND length(c.ucp_id) <> 19;

-- 7. revocation_loans: is_deleted = TRUE (если записей нет — UPDATE ничего не изменит)
UPDATE revocation_loans rl
SET is_deleted = TRUE
FROM batch_input b
WHERE rl.ext_ref_a = b.ext_ref_a;

-- 8. loan_cession: is_recalculated = TRUE, часть полей затирается
UPDATE loan_cession lc
SET is_recalculated         = TRUE,
    percent                 = NULL,
    min_price               = NULL,
    min_price_date          = NULL,
    client_id               = NULL,
    client_terbank          = NULL,
    client_osb              = NULL,
    lots_id                 = NULL,
    cession_agreement_id    = NULL,
    fact_price              = NULL,
    actual_cessionary_price = NULL,
    fact_percent            = NULL,
    blocked_status          = NULL,
    loan_product            = NULL
FROM batch_input b
WHERE lc.loan_id IN (SELECT l.id FROM loan l WHERE l.ext_ref_a = b.ext_ref_a);

-- ============================================================
-- КОНТРОЛЬ: полные срезы всех затрагиваемых таблиц после обновления.
-- Каждый срез выполняется по всем договорам, попавшим в batch_input, —
-- результат удобно просматривать в DBeaver построчно, вручную проверяя,
-- как отработали обновления. (Старые сводные SELECT-ы удалены как
-- дублирующие эти срезы.)
-- ============================================================

-- Контроль 1. loan
SELECT *
FROM loan
WHERE ext_ref_a IN (SELECT ext_ref_a FROM batch_input);

-- Контроль 2. loan_agreement
SELECT *
FROM loan_agreement la
WHERE la.loan_id IN (SELECT l.id FROM loan l JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a);

-- Контроль 3. loan_debt
SELECT *
FROM loan_debt ld
WHERE ld.loan_id IN (SELECT l.id FROM loan l JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a);

-- Контроль 4. loan_debt_fix
SELECT *
FROM loan_debt_fix ldf
WHERE ldf.loan_id IN (SELECT l.id FROM loan l JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a);

-- Контроль 5. loan_life_cycle
SELECT *
FROM loan_life_cycle llc
WHERE llc.ext_ref_a IN (SELECT ext_ref_a FROM batch_input);

-- Контроль 6. relationship_client_loan
SELECT *
FROM relationship_client_loan rcl
WHERE rcl.ext_ref_a IN (SELECT ext_ref_a FROM batch_input);

-- Контроль 7. client — клиент ищется по цепочке rcl.ext_ref_c
SELECT *
FROM client c
WHERE c.ext_ref_c IN (
        SELECT rcl.ext_ref_c
        FROM relationship_client_loan rcl
        JOIN batch_input b ON rcl.ext_ref_a = b.ext_ref_a
);

-- Контроль 8. revocation_loans
SELECT *
FROM revocation_loans
WHERE ext_ref_a IN (SELECT ext_ref_a FROM batch_input);

-- Контроль 9. loan_cession
SELECT *
FROM loan_cession lc
WHERE lc.loan_id IN (SELECT l.id FROM loan l JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a);

COMMIT;`;
}

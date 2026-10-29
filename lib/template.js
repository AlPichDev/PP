/**
 * Встроенный SQL-скрипт пакетного обновления договоров (PostgreSQL).
 *
 * КАК РАБОТАЕТ: договоры НЕ вводятся вручную — скрипт сам отбирает их
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
 * ЗНАЧЕНИЯ — ПОСТРОЧНО: LIMIT = 10 → в форме 10 строк, каждая со своим
 * новым ЕКП (loan.ekp_id) и своими двумя суммами просрочки (пусто =
 * «не трогать», работают через COALESCE как раньше). Строка формы № i
 * применяется к i-му отобранному договору: отбор детерминирован
 * (ORDER BY ext_ref_a), нумеруется через ROW_NUMBER(), а JOIN по номеру
 * строки раздаёт каждому договору его персональные значения.
 * Строки с незаполненным ЕКП автоматически исключаются из пакета —
 * защита от случайной записи NULL в loan.ekp_id.
 *
 * Структура скрипта: TEMP batch_params (VALUES построчно из формы) →
 * TEMP batch_input (отбор × параметры по номеру строки) → 2 контрольные
 * проверки → восемь отдельных UPDATE (включая два корректировщика длин
 * sberbank_account_number = 20 и client.ucp_id = 19 символов,
 * LEFT(RPAD(...))) → девять контрольных SELECT * по всем затрагиваемым
 * таблицам (loan, loan_agreement, loan_debt, loan_debt_fix,
 * loan_life_cycle, relationship_client_loan, client, revocation_loans,
 * loan_cession) → COMMIT.
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

/** Пустая строка формы (эталон для дозаполнения) */
export const EMPTY_ROW = Object.freeze({
  ekpId: "",
  loanAmount: "",
  interestAmount: "",
});

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

const normalizeRow = (r) => ({
  ekpId: String(r?.ekpId ?? "").trim(),
  loanAmount: normNum(r?.loanAmount),
  interestAmount: normNum(r?.interestAmount),
});

/** Массив строк формы → нормализованный (обрезка до MAX_LIMIT, trim) */
export function normalizeRows(rows) {
  const src = Array.isArray(rows) ? rows : [];
  return src.slice(0, MAX_LIMIT).map(normalizeRow);
}

/** Человекочитаемое значение для шапки скрипта */
const humanNum = (v) => {
  const s = normNum(v);
  return NUM_RE.test(s) ? s : "не трогаем";
};

/**
 * Валидация полей формы → массив текстов ошибок.
 * state: { limit, rows: [{ ekpId, loanAmount, interestAmount }, ...] }
 * Проверяются ровно limit строк: пустая строка — это незаполненный
 * договор, она даёт ошибку «не заполнен ЕКП» (но не ломает SQL).
 */
export function validateForm(state = {}) {
  const errors = [];

  const limitRaw = String(state.limit ?? "").trim();
  if (limitRaw === "") {
    errors.push("Укажите количество договоров (LIMIT)");
  } else if (!INT_RE.test(limitRaw)) {
    errors.push("LIMIT — целое число");
  } else if (Number(limitRaw) < MIN_LIMIT || Number(limitRaw) > MAX_LIMIT) {
    errors.push(`LIMIT — от ${MIN_LIMIT} до ${MAX_LIMIT}`);
  }

  const limitN = clampLimit(state.limit);
  const rows = normalizeRows(state.rows);
  for (let i = 0; i < limitN; i++) {
    const n = i + 1;
    const row = rows[i] ?? EMPTY_ROW;

    const ekp = row.ekpId;
    if (ekp === "") {
      errors.push(
        `Строка ${n}: не заполнен новый ЕКП (loan.ekp_id) — договор исключается из пакета`,
      );
    } else if (!INT_RE.test(ekp)) {
      errors.push(`Строка ${n}: новый ЕКП (loan.ekp_id) — целое число`);
    }

    if (row.loanAmount !== "" && !NUM_RE.test(row.loanAmount)) {
      errors.push(
        `Строка ${n}: просрочка по телу (overdue_loan_amount) — число (запятая заменится на точку)`,
      );
    }

    if (row.interestAmount !== "" && !NUM_RE.test(row.interestAmount)) {
      errors.push(
        `Строка ${n}: просрочка по процентам (overdue_interest_amount) — число (запятая заменится на точку)`,
      );
    }
  }

  return errors;
}

/** Значения формы, приведённые к «эффективным» величинам для UI */
export function effectiveForm(state = {}) {
  return {
    limit: clampLimit(state.limit),
    rows: normalizeRows(state.rows),
  };
}

/** Сколько строк реально попадёт в пакет (валидный ЕКП, первые limit) */
export function countPackageRows(state = {}) {
  const limit = clampLimit(state.limit);
  return normalizeRows(state.rows)
    .slice(0, limit)
    .filter((r) => INT_RE.test(r.ekpId)).length;
}

/* ---------- Шаблон скрипта ---------- */

export function renderBatchSQL(state = {}) {
  const limit = clampLimit(state.limit);
  const rows = normalizeRows(state.rows).slice(0, limit);

  // В пакет идут только строки с корректным (непустым целым) ЕКП.
  // Строка с пустым ЕКП просто выпадает: JOIN batch_params по номеру
  // строки оставит договор без параметров за бортом пакета.
  const paramRows = rows
    .map((row, idx) => ({ num: idx + 1, ...row }))
    .filter((r) => INT_RE.test(r.ekpId));

  const valuesSql =
    paramRows.length === 0
      ? null
      : paramRows
          .map((r) => {
            const loanLit =
              r.loanAmount !== "" && NUM_RE.test(r.loanAmount)
                ? `${r.loanAmount}::numeric`
                : "NULL::numeric";
            const intrLit =
              r.interestAmount !== "" && NUM_RE.test(r.interestAmount)
                ? `${r.interestAmount}::numeric`
                : "NULL::numeric";
            return `    (${r.num}, ${r.ekpId}::bigint, ${loanLit}, ${intrLit})`;
          })
          .join(",\n") + ";";

  // Шапка: построчный список значений (для сверки глазами в DBeaver)
  const rowsHuman = rows
    .slice(0, Math.max(rows.length, 0))
    .map((row, idx) => {
      const n = idx + 1;
      if (!INT_RE.test(row.ekpId)) {
        return `--     ${n} → (пропущена: ЕКП не заполнен/некорректен)`;
      }
      return `--     ${n} → ЕКП ${row.ekpId} · тело ${humanNum(row.loanAmount)} · проценты ${humanNum(row.interestAmount)}`;
    });
  const rowsHumanBlock =
    rowsHuman.length > 0
      ? rowsHuman.join("\n")
      : `--     (нет ни одной строки — пакет будет пустым)`;

  const paramsInsert = valuesSql
    ? `INSERT INTO batch_params (row_num, new_ekp_id, overdue_loan_amount, overdue_interest_amount)
VALUES
${valuesSql}`
    : `-- (строк не добавлено: заполните ЕКП хотя бы в одной строке формы)`;

  return `
-- Параметры из формы:
--   LIMIT (сколько договоров) ................ ${limit}
--   Значения по строкам (№ → ЕКП · тело · проценты):
${rowsHumanBlock}

BEGIN;

CREATE TEMP TABLE batch_params (
    row_num                 int,
    new_ekp_id              bigint,
    overdue_loan_amount     numeric,
    overdue_interest_amount numeric
) ON COMMIT DROP;

${paramsInsert}

CREATE TEMP TABLE batch_input (
    row_num                 int,
    ext_ref_a               text,
    new_ekp_id              bigint,
    overdue_loan_amount     numeric,
    overdue_interest_amount numeric
) ON COMMIT DROP;

INSERT INTO batch_input (row_num, ext_ref_a, new_ekp_id, overdue_loan_amount, overdue_interest_amount)
SELECT rn.row_num,
       rn.ext_ref_a,
       bp.new_ekp_id,
       bp.overdue_loan_amount,
       bp.overdue_interest_amount
FROM (
    SELECT ROW_NUMBER() OVER (ORDER BY llc.ext_ref_a) AS row_num,
           llc.ext_ref_a
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
    LIMIT ${limit}
) rn
JOIN batch_params bp ON bp.row_num = rn.row_num;

SELECT b.ext_ref_a AS missing_ext_ref_a
FROM batch_input b
LEFT JOIN loan l ON l.ext_ref_a = b.ext_ref_a
WHERE l.id IS NULL;

SELECT l.ext_ref_a, l.ekp_id, l.is_deleted
FROM loan l
JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a
WHERE l.is_deleted;

UPDATE loan l
SET ekp_id      = b.new_ekp_id,
    pprb_tkp_id = NULL
FROM batch_input b
WHERE l.ext_ref_a = b.ext_ref_a;

UPDATE loan_life_cycle llc
SET life_stage_id   = 3,
    portfolio_id    = NULL,
    cession_part_id = NULL
FROM batch_input b
WHERE llc.ext_ref_a = b.ext_ref_a;

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

UPDATE loan_agreement la
SET debt_type_code = 9
FROM batch_input b
WHERE la.loan_id IN (SELECT l.id FROM loan l WHERE l.ext_ref_a = b.ext_ref_a);

UPDATE loan_agreement la
SET sberbank_account_number = LEFT(RPAD(la.sberbank_account_number, 20, '0'), 20)
FROM batch_input b
WHERE la.loan_id IN (SELECT l.id FROM loan l WHERE l.ext_ref_a = b.ext_ref_a)
  AND length(la.sberbank_account_number) <> 20;

UPDATE client c
SET ucp_id = LEFT(RPAD(c.ucp_id, 19, '0'), 19)
FROM relationship_client_loan rcl
JOIN batch_input b ON rcl.ext_ref_a = b.ext_ref_a
WHERE c.ext_ref_c = rcl.ext_ref_c
  AND length(c.ucp_id) <> 19;

UPDATE revocation_loans rl
SET is_deleted = TRUE
FROM batch_input b
WHERE rl.ext_ref_a = b.ext_ref_a;

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

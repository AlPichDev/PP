/**
 * Встроенный SQL-скрипт пакетного обновления (PostgreSQL).
 *
 * Реализует ручной алгоритм обработки в DBeaver, но одной транзакцией:
 * каждая таблица обновляется ОТДЕЛЬНЫМ UPDATE, перед изменениями идут
 * контрольные SELECT-проверки (существование займов, is_deleted), а
 * sberbank_account_number и client.ucp_id правятся корректировщиками —
 * UPDATE-ами, приводящими значение к нужной длине (20/19 символов):
 * короче — в конце дописываются нули, длиннее — лишнее стирается с конца
 * (LEFT(RPAD(значение, N, '0'), N)).
 *
 * Вход: одна строка = один займ, ключ — loan.ext_ref_a (EKPLA…).
 * Через подзапросы по ext_ref_a находятся loan.id (019…) для loan_debt,
 * loan_agreement, loan_cession и relationship_client_loan.ext_ref_c
 * (LC…) для client — пользователю не нужно вводить их вручную.
 *
 * Семантика пустой ячейки: она превращается в NULL в batch_input, а
 * COALESCE в UPDATE подставляет старое значение из БД — т.е. пустая
 * ячейка означает «это поле не трогать». Фиксированные значения
 * (life_stage_id = 3, debt_type_code = 9, is_recalculated = TRUE и т.д.)
 * и списки зануления зашиты в шаблон ниже — при изменении алгоритма
 * правьте их здесь.
 *
 * rows — массив строк таблицы { extRefA, ekpId, ... } (см. emptyRow()).
 */
import { COLS, toLiteral } from "./columns";

export const SAVE_FILENAME = "batch_loans_updates.sql";

/* Определения колонок CREATE TEMP TABLE (типы выровнены по ширине имени) */
const COLUMN_DEFS = (() => {
  const w = Math.max(...COLS.map((c) => c.name.length)) + 1;
  return COLS.map((c) => `    ${c.name.padEnd(w)}${c.type}`).join(",\n");
})();

/* Список колонок INSERT: по 2 на строку, чтобы листинг оставался читаемым */
const INSERT_COLS = (() => {
  const names = COLS.map((c) => c.name);
  const lines = [];
  for (let i = 0; i < names.length; i += 2) {
    lines.push(`    ${names.slice(i, i + 2).join(", ")}`);
  }
  return lines.join(",\n");
})();

export function renderBatchSQL(rows) {
  const values =
    rows
      .map((row, i) => {
        const comma = i === rows.length - 1 ? "" : ",";
        const lits = COLS.map((c) => toLiteral(c, row[c.key])).join(", ");
        return `    (${lits})${comma}`;
      })
      .join("\n") || "    -- нет данных";

  return `BEGIN;

-- Входные данные пакета: одна строка = один займ (ключ — ext_ref_a из loan)
CREATE TEMP TABLE batch_input (
${COLUMN_DEFS}
) ON COMMIT DROP;

INSERT INTO batch_input (
${INSERT_COLS}
) VALUES
${values};

SELECT b.ext_ref_a AS missing_ext_ref_a
FROM batch_input b
LEFT JOIN loan l ON l.ext_ref_a = b.ext_ref_a
WHERE l.id IS NULL;

SELECT l.ext_ref_a, l.ekp_id, l.is_deleted
FROM loan l
JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a
WHERE l.is_deleted;

UPDATE loan l
SET ekp_id      = b.ekp_id,
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

SELECT l.id, l.ext_ref_a, l.ekp_id
FROM loan l
JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a
ORDER BY l.ext_ref_a;

SELECT l.ext_ref_a,
       la.sberbank_account_number,
       length(la.sberbank_account_number) AS sber_len,
       c.ucp_id,
       length(c.ucp_id)                   AS ucp_len
FROM loan l
JOIN batch_input b ON l.ext_ref_a = b.ext_ref_a
LEFT JOIN loan_agreement la ON la.loan_id = l.id
LEFT JOIN relationship_client_loan rcl ON rcl.ext_ref_a = l.ext_ref_a
LEFT JOIN client c ON c.ext_ref_c = rcl.ext_ref_c
ORDER BY l.ext_ref_a;

COMMIT;`;
}

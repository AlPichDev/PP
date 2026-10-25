/**
 * Единое описание колонок таблицы пакетного обновления.
 *
 * Это ЕДИНСТВЕННОЕ место, где задан набор полей: таблица на форме
 * (DataGrid.jsx), CREATE TEMP TABLE и INSERT в шаблоне (lib/template.js)
 * и валидация строятся из этого списка. Чтобы добавить/убрать поле —
 * достаточно править здесь.
 *
 * Одна строка таблицы = один займ. Ключ строки — ext_ref_a (EKPLA…):
 * по нему находятся loan, loan_life_cycle, relationship_client_loan и
 * revocation_loans; loan.id через подзапрос — loan_debt, loan_agreement,
 * loan_cession (см. lib/template.js).
 *
 * type: "bigint" | "numeric" | "text"
 * required — ячейку нельзя оставлять пустой (иначе строка не пройдёт проверку)
 * width — минимальная ширина колонки на форме, px
 *
 * Поля, которые в скрипте меняются фиксированно (life_stage_id = 3,
 * debt_type_code = 9, is_deleted = TRUE, is_recalculated = TRUE, списки
 * зануления), в форму не вынесены — они зашиты в lib/template.js.
 */
import { pgQuote } from "./sql";

export const COLS = [
  {
    key: "extRefA",
    table: "loan",
    name: "ext_ref_a",
    type: "text",
    required: true,
    width: 230,
    placeholder: "напр. EKPLA0001",
  },
  {
    key: "ekpId",
    table: "loan",
    name: "ekp_id",
    title: "ekp_id (новый)",
    type: "bigint",
    required: true,
    width: 150,
    placeholder: "напр. 9001",
  },
  {
    key: "overdueLoanAmount",
    table: "loan_debt",
    name: "overdue_loan_amount",
    type: "numeric",
    width: 170,
    placeholder: "напр. 1500.00",
  },
  {
    key: "overdueInterestAmount",
    table: "loan_debt",
    name: "overdue_interest_amount",
    type: "numeric",
    width: 180,
    placeholder: "напр. 250.50",
  },
];

/** Полное имя колонки для заголовков и сообщений. title — человекочитаемая
 *  подпись (например «ekp_id (новый)»), в SQL уходит чистое name. */
export const colTitle = (col) =>
  col.title ? `${col.table}.${col.title}` : `${col.table}.${col.name}`;

/* ---------- Литералы PostgreSQL ---------- */

const INT_RE = /^\d+$/;
const NUM_RE = /^-?\d+(\.\d+)?$/;

/** Пользователи часто вводят запятую в дробях — нормализуем к точке */
const normNum = (v) => v.replace(",", ".");

/** Значение ячейки → SQL-литерал. Пустая ячейка → NULL («значение не менять»). */
export function toLiteral(col, value) {
  const v = (value ?? "").trim();
  if (v === "") return "NULL";
  switch (col.type) {
    case "bigint":
      return INT_RE.test(v) ? v : "NULL";
    case "numeric":
      return NUM_RE.test(normNum(v)) ? normNum(v) : "NULL";
    default:
      return pgQuote(v); // text
  }
}

/** Валидация одной ячейки (для подсветки в таблице) */
export function validateCell(col, value) {
  const v = (value ?? "").trim();
  if (v === "") return !col.required;
  switch (col.type) {
    case "bigint":
      return INT_RE.test(v);
    case "numeric":
      return NUM_RE.test(normNum(v));
    default:
      return true; // text — любая непустая строка корректна
  }
}

/** Что ожидается в ячейке — для сообщений об ошибках */
function expectation(col) {
  switch (col.type) {
    case "bigint":
      return "ожидается целое число";
    case "numeric":
      return "ожидается число";
    default:
      return "ожидается текст";
  }
}

/**
 * Валидация всех строк таблицы → массив текстов ошибок.
 * Дополнительно ловит дубли ext_ref_a: колонка batch_input.ext_ref_a —
 * PRIMARY KEY, дублирующийся ключ уронит INSERT уже на стороне БД.
 */
export function validateRows(rows) {
  const errors = [];
  const seen = new Map(); // ext_ref_a → номер строки

  rows.forEach((row, i) => {
    const n = i + 1;
    for (const col of COLS) {
      if (!validateCell(col, row[col.key])) {
        const v = (row[col.key] ?? "").trim();
        errors.push(
          v === ""
            ? `Строка ${n}: не заполнено ${colTitle(col)}`
            : `Строка ${n}: ${colTitle(col)} — ${expectation(col)}`,
        );
      }
    }

    const ref = (row.extRefA ?? "").trim();
    if (ref !== "") {
      if (seen.has(ref)) {
        errors.push(
          `Строка ${n}: ${ref} повторяется (уже в строке ${seen.get(ref)})`,
        );
      } else {
        seen.set(ref, n);
      }
    }
  });

  return errors;
}

/** Пустая строка таблицы (все ячейки незаполнены) */
export function emptyRow() {
  const row = {};
  for (const col of COLS) row[col.key] = "";
  return row;
}

"use client";

/**
 * Редактируемая таблица: по строке на каждый займ.
 * Набор колонок описан в lib/columns.js (COLS) — оттуда же берутся
 * валидация и SQL-литералы. Пустая ячейка = «значение не менять»
 * (кроме обязательных колонок).
 */
import { COLS, colTitle, validateCell } from "@/lib/columns";

const INPUT_MODE = { bigint: "numeric", numeric: "decimal", text: "text" };

function Cell({ col, value, onCellChange, rowNumber }) {
  return (
    <input
      className={`cell-input${value.trim() !== "" && !validateCell(col, value) ? " invalid" : ""}`}
      value={value}
      onChange={(e) => onCellChange(rowNumber - 1, col.key, e.target.value)}
      inputMode={INPUT_MODE[col.type] ?? "text"}
      placeholder={col.placeholder ?? ""}
      spellCheck={false}
      aria-label={`Строка ${rowNumber}, ${colTitle(col)}`}
    />
  );
}

export default function DataGrid({ rows, onCellChange }) {
  return (
    <div className="grid-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th className="th-num">#</th>
            {COLS.map((col) => (
              <th key={col.key} style={{ minWidth: col.width }}>
                {colTitle(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="row-num">{i + 1}</td>
              {COLS.map((col) => (
                <td key={col.key}>
                  <Cell
                    col={col}
                    value={row[col.key] ?? ""}
                    onCellChange={onCellChange}
                    rowNumber={i + 1}
                  />
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="row-num">1</td>
              {COLS.map((col) => (
                <td key={col.key}>
                  <Cell col={col} value="" onCellChange={onCellChange} rowNumber={1} />
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { highlightSQL } from "@/lib/sql";

/** Панель предпросмотра: подсвеченный SQL, статистика, предупреждения, действия */
export default function PreviewPanel({ sql, errors, limit, onCopy, onSave }) {
  return (
    <div className="card card-preview">
      <div className="card-head">
        <h2>Предпросмотр</h2>
        <div className="stats">
          <span className="stat">LIMIT: {limit}</span>
          <span className="stat">8 UPDATE · 9 контрольных SELECT</span>
          <span className="stat">{sql.length} симв.</span>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="warn-box" role="status">
          <strong>Проверьте параметры:</strong>
          <ul className="warn-list">
            {errors.slice(0, 6).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {errors.length > 6 && <li>… и ещё {errors.length - 6}</li>}
          </ul>
        </div>
      )}

      <pre className="code" aria-label="Сгенерированный SQL">
        <code dangerouslySetInnerHTML={{ __html: highlightSQL(sql) }} />
      </pre>

      <div className="actions">
        <button className="btn btn-primary" onClick={onCopy}>
          Копировать
        </button>
        <button className="btn" onClick={onSave} disabled={sql.trim() === ""}>
          Сохранить .sql
        </button>
      </div>
    </div>
  );
}

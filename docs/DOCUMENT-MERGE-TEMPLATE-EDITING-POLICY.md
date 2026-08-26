# Document Merge — template version editing policy

## Normal template revisions: UI workflow only

Ordinary template HTML/CSS changes — wording tweaks, layout fixes, adding a
field, adjusting typography — go through the **admin UI**, not a SQL
migration:

```
Trộn tài liệu → Quản lý Templates → Phiên bản Template
```

1. **Tạo bản nháp từ phiên bản này** — clone any existing version (PUBLISHED,
   ARCHIVED, or another DRAFT) into a new DRAFT. The source version is never
   modified; the new DRAFT's `mapping_snapshot` always starts empty (`[]`) —
   snapshots are only frozen at Publish.
2. **Sửa HTML/CSS** — edit the DRAFT's `htmlBody`/`printCss` directly, or use
   the AI-assisted paste-a-full-document flow (dán một tài liệu HTML hoàn
   chỉnh → Phân tích → Xem trước chưa lưu → Áp dụng vào bản nháp). Only
   `status = 'DRAFT'` rows can ever be edited — the server enforces this in
   the same `UPDATE ... WHERE status = 'DRAFT'` statement, not just in the UI.
3. **Xem trước** / **In / Lưu PDF TEST** — render the DRAFT against a real
   candidate, read-only, zero DB writes, before deciding to publish.
4. **Xuất bản phiên bản** — publish, gated by the checklist modal (machine
   checks + 5 explicit operator confirmations). This freezes the current
   mapping into `mapping_snapshot`, archives the previously PUBLISHED version,
   and updates `merge_templates.current_published_version` — all inside one
   transaction.
5. **Lưu trữ bản nháp** / **Xóa bản nháp** — archive a DRAFT you no longer
   need, or permanently delete one (only DRAFT rows, and only if never
   referenced by `document_history`).

None of this requires touching `migrations/`.

## When a SQL migration is still the right tool

Reserve a migration under `migrations/` for:

- **Schema evolution** — adding/altering columns, tables, indexes.
- **One-time data repair** — fixing a specific, already-diagnosed data
  inconsistency (e.g. an incident recovery migration).
- **Bootstrap / seeding** — creating the very first template row, seeding
  system permissions, or other first-run setup that has no UI yet.
- **Emergency recovery** — restoring a known-good state after an incident,
  when the normal UI path cannot be used (e.g. the DB itself is in an
  inconsistent state the UI's own invariants would refuse to operate on).

A migration is the wrong tool for an ordinary template content/layout
revision — use the version workflow above instead. This keeps every
non-emergency change auditable through the same `writeAudit()` trail as
every other admin action, and keeps the migration history free of
one-off content edits that have nothing to do with schema.

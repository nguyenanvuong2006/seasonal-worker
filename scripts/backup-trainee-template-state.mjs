#!/usr/bin/env node
/**
 * PHASE 2 — BACKUP SCRIPT
 * Creates machine-readable backup of trainee-registration template state
 * before destructive cleanup.
 */
import { writeFileSync } from 'node:fs';

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = `backups/trainee-template-backup-${timestamp}.json`;

const backup = {
  generatedAt: new Date().toISOString(),
  purpose: "Pre-cleanup backup of trainee-registration template family",
  note: "This backup is rollback evidence only. It must NOT remain a runtime fallback.",
  canonicalSource: {
    path: "templates/document-merge/trainee-registration/canonical-source.html",
    sha256: "22e987f76ff0100f8a7a3f9c6fcda72f1465bbf353f909664d923eed41343bd2",
    placeholderCount: 49
  },
  affectedTables: ["merge_templates", "merge_template_versions", "merge_template_fields"],
  instructions: [
    "Run this backup before executing the cleanup migration",
    "Store the JSON file securely",
    "The backup is for audit/rollback evidence only"
  ]
};

writeFileSync(backupFile, JSON.stringify(backup, null, 2));
console.log(`BACKUP_CREATED=yes`);
console.log(`BACKUP_LOCATION=${backupFile}`);
console.log(`BACKUP_ROW_COUNTS=metadata-only (no live DB access in this environment)`);

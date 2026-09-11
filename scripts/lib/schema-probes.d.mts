/**
 * Type declarations for schema-probes.mjs — hand-written, not generated.
 * Same rationale as migration-ledger.d.mts.
 */
import type { PgLikeClient } from "./migration-ledger.d.mts";

export function tableExists(client: PgLikeClient, tableName: string): Promise<boolean>;
export function columnExists(client: PgLikeClient, tableName: string, columnName: string): Promise<boolean>;
export function indexExists(client: PgLikeClient, indexName: string): Promise<boolean>;
export function constraintExists(client: PgLikeClient, constraintName: string): Promise<boolean>;
export function functionExists(client: PgLikeClient, functionName: string): Promise<boolean>;
export function triggerExists(client: PgLikeClient, triggerName: string): Promise<boolean>;
export function extensionExists(client: PgLikeClient, extensionName: string): Promise<boolean>;
export function viewExists(client: PgLikeClient, viewName: string): Promise<boolean>;
export function scheduledJobExists(client: PgLikeClient, jobKey: string): Promise<boolean>;

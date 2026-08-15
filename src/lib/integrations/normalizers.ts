import type { ExternalSystemMapping, SourceSystem } from "./types.ts";

export function normalizeSourceSystem(value: string): SourceSystem {
  return value.trim().replace(/[\s-]+/g, "_").toUpperCase() as SourceSystem;
}

export function mappingKey(sourceSystem: SourceSystem, entityType: string, externalId: string): string {
  return `${normalizeSourceSystem(sourceSystem)}:${entityType.trim().toLowerCase()}:${externalId.trim()}`;
}

/** Resolve exactly one canonical ID. Ambiguous/missing mappings fail closed. */
export function resolveCanonicalId(
  mappings: ExternalSystemMapping[],
  sourceSystem: SourceSystem,
  entityType: ExternalSystemMapping["entityType"],
  externalId: string,
  effectiveDate: string,
): string | null {
  const key = mappingKey(sourceSystem, entityType, externalId);
  const active = mappings.filter((m) =>
    mappingKey(m.sourceSystem, m.entityType, m.externalId) === key &&
    m.effectiveFrom <= effectiveDate &&
    (!m.effectiveTo || m.effectiveTo >= effectiveDate),
  );
  return active.length === 1 ? active[0].internalId : null;
}

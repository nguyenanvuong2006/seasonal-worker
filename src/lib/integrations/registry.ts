import type { SourceSystem, WorkforceConnector } from "./types.ts";

/** Small in-process registry; no event bus or connector is activated by default. */
export class WorkforceConnectorRegistry {
  private readonly connectors = new Map<string, WorkforceConnector<unknown>>();

  register<T>(connector: WorkforceConnector<T>): void {
    const key = String(connector.sourceSystem).toUpperCase();
    if (this.connectors.has(key)) throw new Error(`Connector already registered: ${key}`);
    this.connectors.set(key, connector as WorkforceConnector<unknown>);
  }

  get(sourceSystem: SourceSystem): WorkforceConnector<unknown> | null {
    return this.connectors.get(String(sourceSystem).toUpperCase()) ?? null;
  }

  list(): SourceSystem[] {
    return [...this.connectors.keys()] as SourceSystem[];
  }
}

export const workforceConnectorRegistry = new WorkforceConnectorRegistry();

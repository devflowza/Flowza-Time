/** Deterministic seed data (§93). Populated by the seed implementation; see docs/development.md. */
export interface SeedOptions { connectionString: string; days?: number }
export interface SeedSummary { organizations: number; branches: number; employees: number; devices: number; rawTransactions: number }

export async function runSeed(_opts: SeedOptions): Promise<SeedSummary> {
  throw new Error('Seed not implemented yet — see packages/database/src/seed');
}

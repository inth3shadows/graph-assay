export class Orchestrator {
  private inputs: { paths: Map<string, string> } | null = null;

  check(rel: string): boolean {
    return this.inputs !== null && this.inputs.paths.has(rel);
  }
}

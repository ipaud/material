/** Short unique id for project entities (sources, mappings, looks). */
export function uid(prefix = ''): string {
  const raw = crypto.randomUUID().slice(0, 8);
  return prefix ? `${prefix}_${raw}` : raw;
}

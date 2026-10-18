import { describe, expect, test } from 'vitest';
import {
  createEmptyProject,
  parseProjectDetailed,
  repairProject,
  triggerMappingSchema,
} from '@shared/schemas/project';

function trigger(id: string, amount: number) {
  return { ...triggerMappingSchema.parse({ id, enabled: true, source: 'beat', action: 'pulse' }), amount };
}

function withTriggers(amounts: number[]): unknown {
  const project = createEmptyProject('Bad');
  return { ...project, triggers: amounts.map((a, i) => trigger(`t${i}`, a)) };
}

describe('parseProjectDetailed', () => {
  test('valid project parses with no issues', () => {
    const r = parseProjectDetailed(createEmptyProject('Ok'));
    expect(r.ok).toBe(true);
  });

  test('trigger.amount 1.125 reports path, value and max', () => {
    const r = parseProjectDetailed(withTriggers([0.2, 0.3, 0.4, 1.125]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({
      path: 'triggers[3].amount',
      received: 1.125,
      max: 1,
      repairable: true,
    });
    expect(r.issues[0]!.text).toBe('triggers[3].amount = 1.125 (max 1)');
  });

  test('lists every problem, not just the first', () => {
    const r = parseProjectDetailed(withTriggers([2, -3, 0.5, 1.5, 9, -9]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toEqual([
      'triggers[0].amount',
      'triggers[1].amount',
      'triggers[3].amount',
      'triggers[4].amount',
      'triggers[5].amount',
    ]);
  });

  test('structural errors are listed but not repairable', () => {
    const r = parseProjectDetailed({ ...createEmptyProject(), name: 42 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => !i.repairable)).toBe(true);
  });
});

describe('repairProject', () => {
  test('clamps out-of-range numbers and yields a valid project', () => {
    const r = parseProjectDetailed(withTriggers([1.125, -4]));
    if (r.ok) throw new Error('expected failure');
    const fixed = repairProject(r.migrated);
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.project.triggers.map((t) => t.amount)).toEqual([1, -1]);
    expect(fixed.repaired.map((i) => i.path)).toEqual(['triggers[0].amount', 'triggers[1].amount']);
  });

  test('refuses when a non-numeric problem remains', () => {
    const r = parseProjectDetailed({ ...(withTriggers([2]) as object), name: 42 });
    if (r.ok) throw new Error('expected failure');
    const fixed = repairProject(r.migrated);
    expect(fixed.ok).toBe(false);
  });
});

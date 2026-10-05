import { describe, expect, it } from 'vitest';
import {
  addEntrySchema,
  createGroupSchema,
  DEFAULT_GROUP_COLOR,
} from '../../src/lib/shared/schemas';

const validAdd = {
  id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
  serverInstanceId: '6ba7b811-9dad-41d1-80b4-00c04fd430c8',
  name: '  Eggs  ',
  groupIds: [],
};

describe('request schemas', () => {
  it('trims display names and accepts arbitrary names', () => {
    expect(addEntrySchema.parse(validAdd).name).toBe('Eggs');
  });

  it('rejects blank names and repeated group assignments', () => {
    expect(addEntrySchema.safeParse({ ...validAdd, name: '  ' }).success).toBe(
      false,
    );
    expect(
      addEntrySchema.safeParse({
        ...validAdd,
        groupIds: [
          '6ba7b812-9dad-41d1-80b4-00c04fd430c8',
          '6ba7b812-9dad-41d1-80b4-00c04fd430c8',
        ],
      }).success,
    ).toBe(false);
  });

  it('requires a store or category kind when creating a group', () => {
    const result = createGroupSchema.safeParse({
      serverInstanceId: validAdd.serverInstanceId,
      name: 'Market',
    });
    expect(result.success).toBe(false);
  });

  it('defaults new group colors and accepts only six-digit hex colors', () => {
    const group = createGroupSchema.parse({
      serverInstanceId: validAdd.serverInstanceId,
      name: 'Market',
      kind: 'category',
    });
    expect(group.color).toBe(DEFAULT_GROUP_COLOR);
    expect(
      createGroupSchema.safeParse({ ...group, color: 'amber' }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { newMigratedDb } from '../../../../../../../packages/storage-node/src/test-support/test-db';
import { COLOR_MAP, ICON_MAP } from '../../../../../src/components/aibox/types';

// What breaks if this suite goes red: the Social category (storage-node
// migration v99) shows in the app with the generic tag icon or another
// category's colour. The category pills fall back to Tag and blue when a row's
// icon or colour is missing from the renderer's maps, which would make Social
// look like Reminders. The rows are read from a real migrated database, so a
// change to the migration's icon or colour is checked against these maps.

type Row = { slug: string; icon: string; color: string };

const systemCategories = (): Row[] => {
  const db = newMigratedDb();
  try {
    return db.prepare('SELECT slug, icon, color FROM ai_category_definitions WHERE is_system = 1').all() as Row[];
  } finally {
    db.close();
  }
};

describe('Social category display', () => {
  it('uses an icon and a colour the renderer knows', () => {
    const social = systemCategories().find((c) => c.slug === 'social');
    expect(social).toBeDefined();
    expect(ICON_MAP[social!.icon]).toBeDefined();
    expect(COLOR_MAP[social!.color]).toBeDefined();
  });

  it('does not share its colour with another system category', () => {
    const all = systemCategories();
    const social = all.find((c) => c.slug === 'social')!;
    expect(all.filter((c) => c.slug !== 'social').map((c) => c.color)).not.toContain(social.color);
  });
});

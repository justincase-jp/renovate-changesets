import { describe, expect, it } from 'vitest';

import { readFileFromSha } from './git';

describe('git', () => {
  it('readFileFromSha', async () => {
    const file = await readFileFromSha('main', 'package.json');
    expect(file.name).toMatchInlineSnapshot('"renovate-changesets"');
  });
});

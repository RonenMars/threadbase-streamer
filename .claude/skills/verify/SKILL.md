---
name: verify
description: Run full lint + type-check + test suite to verify changes before committing
---

Run the full verification suite for this project:

```bash
npm run lint && npm test
```

This runs type-checking (`tsc --noEmit`), Biome lint, and the vitest test suite.

If any step fails:
1. Read the error output carefully
2. Fix the issue
3. Re-run the full verification to confirm the fix didn't break anything else

Do not mark work as complete until verification passes.

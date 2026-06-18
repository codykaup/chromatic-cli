import type { OnlyAType } from './types';   // type-only → should be ELIDED
import { v } from './esmDep';                // ESM runtime
const c = require('./cjsDep');               // CJS runtime
export const out: OnlyAType = { x: v + c.c };

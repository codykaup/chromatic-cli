/** Collect `require('<literal>')` specifiers from an oxc/ESTree AST (CommonJS support). */
export function collectRequires(node: any, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee?.name === 'require'
  ) {
    const a = node.arguments?.[0];
    if (a && a.type === 'Literal' && typeof a.value === 'string') out.push(a.value);
  }
  for (const k of Object.keys(node)) {
    const v = (node as any)[k];
    if (Array.isArray(v)) for (const c of v) collectRequires(c, out);
    else if (v && typeof v === 'object') collectRequires(v, out);
  }
}

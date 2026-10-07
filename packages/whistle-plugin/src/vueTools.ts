/**
 * Hub-side glue for the get_vue_* MCP tools: they run the SAME page-side
 * serializer the Vue panel uses (lib/panel.js `vueSnippet`, injected into the
 * page via eval_js) instead of a dedicated protocol command. That keeps the
 * tools compatible with every published probe — the wire carries a plain
 * `eval` command, which even old probes answer.
 *
 * serializeOne caps eval results at 2000 chars, so ops that can return more
 * (state) are chunked: the first response carries `len` + the first slice and
 * the rest is fetched with `sslice` pages — same contract the panel follows.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

// lib/panel.js stays outside the bundle (same deal as cli.ts's panel loader):
// required from the package at runtime so panel and hub share one source.
const req = createRequire(path.join(__dirname, 'vueTools.cjs'));

const panelLib = req('../lib/panel.js') as { vueSnippet: (...args: unknown[]) => string };

export function vueEvalExpr(op: string, arg: Record<string, unknown> = {}): string {
  return '(' + panelLib.vueSnippet.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg) + ')';
}

interface VueEvalResult {
  result?: string;
  isException?: boolean;
}

/** Unwrap the eval result envelope and parse the snippet's JSON payload. */
export function parseVueEvalResult(raw: unknown): Record<string, unknown> {
  const r = (raw || {}) as VueEvalResult;
  if (r.isException) {
    throw new Error(r.result || 'eval exception');
  }
  const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { raw: text };
  }
}

/** Fetch a full (chunked) state text for one component. */
export async function fetchVueStateText(
  sendEval: (expression: string) => Promise<unknown>,
  app: number,
  componentPath: string,
): Promise<{ name: string; cut: boolean; text: string }> {
  const head = parseVueEvalResult(await sendEval(vueEvalExpr('state', { app, path: componentPath }))) as {
    name?: string;
    len?: number;
    cut?: boolean;
    s0?: string;
    error?: string;
  };
  if (head.error) {
    throw new Error(head.error);
  }
  let text = head.s0 || '';
  for (let i = 1800; i < (head.len || 0); i += 1800) {
    const slice = parseVueEvalResult(await sendEval(vueEvalExpr('sslice', { i }))) as { s?: string };
    text += slice.s || '';
  }
  return { name: head.name || 'Anonymous', cut: !!head.cut, text };
}

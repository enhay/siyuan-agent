/** Access the runtime's native CommonJS `require` from inside the webpack bundle.
 *
 *  SiYuan desktop (Electron) injects a bare `require` into the plugin module scope
 *  — working plugins use `const fs = require("fs")` directly. It is NOT exposed as
 *  `window.require` / `globalThis.require` (those are undefined), so detecting Node
 *  via them wrongly reports "no Node" and forces the sidecar tier.
 *
 *  `__non_webpack_require__` is webpack's escape hatch: it emits a plain `require`
 *  in the output instead of the bundler's require, so we reach Node's loader. On
 *  mobile/browser (no Node) `typeof` it is safely "undefined" (no ReferenceError). */

declare const __non_webpack_require__: ((m: string) => unknown) | undefined;

export function getNodeRequire(): ((m: string) => any) | undefined {
	try {
		if (typeof __non_webpack_require__ === "function") return __non_webpack_require__ as (m: string) => any;
	} catch {
		/* not defined in this environment */
	}
	const w = typeof window !== "undefined" ? (window as unknown as { require?: (m: string) => any }).require : undefined;
	if (typeof w === "function") return w;
	const g = (globalThis as unknown as { require?: (m: string) => any }).require;
	return typeof g === "function" ? g : undefined;
}

export function hasNode(): boolean {
	return !!getNodeRequire();
}

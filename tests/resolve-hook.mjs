// Test-only module-resolution hook — maps `.js` imports to sibling `.ts` files.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      if (err?.code === "ERR_MODULE_NOT_FOUND" && isRelative && specifier.endsWith(".js")) {
        const tsSpecifier = specifier.slice(0, -3) + ".ts";
        const candidate = new URL(tsSpecifier, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(tsSpecifier, { ...context, parentURL: context.parentURL });
        }
      }
      throw err;
    }
  },
});

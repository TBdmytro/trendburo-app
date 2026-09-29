// Проверка синтаксиса всех JS-файлов и встроенных скриптов HTML (lint-замена без зависимостей).
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
const root = new URL("..", import.meta.url).pathname;
const files = []; const walk = d => { for (const f of readdirSync(d)) { if (f === "node_modules" || f.startsWith(".")) continue; const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
walk(root);
let bad = 0; const tmp = mkdtempSync(join(tmpdir(), "tbchk-"));
for (const f of files) {
  if (f.endsWith(".js")) { try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); } catch (e) { bad++; console.error("✗", f, e.stderr.toString()); } }
  if (f.endsWith(".html") && !f.includes("/test/")) {
    const html = readFileSync(f, "utf8"); let i = 0;
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="(?:text\/x-dc|application\/ld\+json)")[^>]*>([\s\S]*?)<\/script>/g)) {
      const p = join(tmp, `s${i++}.js`); writeFileSync(p, m[1]);
      try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); } catch (e) { bad++; console.error("✗", f, "script #" + i, e.stderr.toString().split("\n").slice(0, 4).join("\n")); }
    }
  }
}
console.log(bad ? `Ошибок: ${bad}` : `Синтаксис в порядке (${files.length} файлов)`);
process.exit(bad ? 1 : 0);

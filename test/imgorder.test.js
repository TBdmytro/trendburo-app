import { test } from "node:test";
import assert from "node:assert/strict";
import { orderImages } from "../lib/imgorder.js";
const A = "https://assets.christiandior.com/is/image/diorprod/", M = "https://media.christiandior.com/cdn-cgi/image/width=3000,format=auto,quality=80/";
test("Dior: лицевой кадр первым, мелкий дубль «в рамке» убран, на модели — в конце и не обрезаются лимитом", () => {
  const src = [M + "pm_1_whr.jpg", A + "2BTCA649JAXH65E_E01?$default_GH$&crop=606,900", A + "2BTCA649JAXH65E_SBG_E07?$r4x5_raw$", A + "2BTCA649JAXH65E_SBG_E01?$r4x5_raw$",
    ...[8, 9, 10, 11, 12, 13].map(n => A + "2BTCA649JAXH65E_SBG_E" + n + "?$r4x5_raw$"), A + "LOOK_H_27_1_LOOK_330_E19?$r4x5_raw$", A + "LOOK_H_27_1_LOOK_330_E20?$r4x5_raw$"];
  const o = orderImages(src, { max: 10 });
  assert.equal(o.length, 10);
  assert.match(o[0], /_SBG_E01/); assert.match(o[1], /_SBG_E07/);
  assert.ok(!o.some(u => u.includes("default_GH")));
  assert.deepEqual(o.slice(-3).map(u => u.includes("LOOK_") || u.includes("media.")), [true, true, true]);
});
test("Dior: нет SBG — берём кадр «в рамке»; не Dior — порядок как пришёл", () => {
  assert.match(orderImages([A + "LOOK_X_E19?x", A + "1UTBA277TPTH820_E06?$default_GH$"])[0], /_E06/);
  const ysl = ["https://saint-laurent.dam.kering.com/a_A.jpg", "https://saint-laurent.dam.kering.com/a_B.jpg"];
  assert.deepEqual(orderImages(ysl), ysl);
});

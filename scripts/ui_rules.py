"""Правила связности интерфейса Trend Büro — запускать после каждого изменения витрины.
Запуск: BASE=http://localhost:3100 CATALOG_MOCK=путь/к/каталогу.json python3 scripts/ui_rules.py"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright
B=os.environ.get("BASE","http://localhost:3100")
MOCK=os.environ.get("CATALOG_MOCK")  # путь к JSON каталога для локальной проверки (необязательно)
async def cat(route): await route.fulfill(path=MOCK, content_type="application/json")
RULES=[]
def ok(name,cond,info=""):RULES.append((name,bool(cond),info))
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch();ctx=await b.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True)
    if MOCK: await ctx.route("**/api/catalog*",cat)
    pg=await ctx.new_page();errs=[];pg.on("pageerror",lambda e:errs.append(str(e)));await pg.goto(B+"/");await pg.wait_for_timeout(3500)
    await pg.evaluate("document.querySelectorAll('.gate,.splash,#splash').forEach(x=>x.remove())")
    for t in ["feed","catalog","services"]:
      await pg.evaluate(f"tab('{t}')");await pg.wait_for_timeout(500)
      r=await pg.evaluate(f"(()=>{{const ti=document.querySelector('#t-{t} .topicons');const a=[...(ti?ti.querySelectorAll('[data-act]'):[])].map(x=>x.dataset.act);return a}})()")
      ok(f"{t}: наверху избранное, корзина, аккаунт",set(["favs","cart","account"])<=set(r),r)
      hasField=await pg.evaluate(f"!!document.querySelector('#t-{t} .searchf')")
      if hasField: ok(f"{t}: есть строка поиска → нет иконки поиска наверху","search" not in " ".join(r),r)
    await pg.evaluate("tab('catalog')");await pg.wait_for_timeout(400)
    ok("каталог: блоки Для неё / Для него",await pg.evaluate("document.querySelectorAll('[data-act=gopen]').length===2"))
    ok("каталог: «Новое» сторис",await pg.evaluate("!document.querySelector('#nwSec').hidden&&document.querySelectorAll('#nIms img').length>0"))
    await pg.click("[data-act=gopen][data-g=w]");await pg.wait_for_timeout(600)
    ok("Для неё: есть «назад» и товары",await pg.evaluate("!!document.querySelector('#catItems:not([hidden]) [data-act=cathome]')&&document.querySelectorAll('#grid .pc').length>0"))
    await pg.click("#catItems [data-act=cathome]");await pg.wait_for_timeout(500)
    ok("назад из списка → пол сброшен",await pg.evaluate("F.g==='all'"))
    id=await pg.evaluate("P.find(p=>p.imgs&&p.imgs.length).id");await pg.evaluate(f"openProduct('{id}')");await pg.wait_for_timeout(1200)
    r=await pg.evaluate("(()=>{const s=[...document.querySelectorAll('.pushed')].pop();return {back:!!s.querySelector('[data-back]'),acc:!!s.querySelector('[data-act=account]'),cart:!!s.querySelector('.navbar [data-act=cart]')}})()")
    ok("карточка товара: есть «назад» и корзина, нет аккаунта",r["back"] and r["cart"] and not r["acc"],r)
    ok("карточка товара: панель вкладок скрыта",await pg.evaluate("document.querySelector('#tabbar').classList.contains('hide')"))
    await pg.wait_for_timeout(1200)
    r2=await pg.evaluate("""(()=>{const s=document.querySelector('.pushed:last-child'),nb=s.querySelector('.navbar'),g=s.querySelector('#pvg'),sl=[...g.querySelectorAll('.sl')],im=g.querySelector('img');
      const sb=sl[0].getBoundingClientRect(),ib=im.getBoundingClientRect(),pad=parseFloat(getComputedStyle(sl[0]).paddingTop),pb=parseFloat(getComputedStyle(sl[0]).paddingBottom);
      const blur=[...g.querySelectorAll('.slb')].some(b=>getComputedStyle(b).display!=='none');
      return {logo:!!nb.querySelector('.nbl'),white:getComputedStyle(nb).backgroundColor,peek:sb.width<g.clientWidth-20,full:sl.every(x=>x.dataset.full==='1'),
        whole:ib.left>=sb.left-1&&ib.right<=sb.right+1&&ib.top>=sb.top+pad-1&&ib.bottom<=sb.bottom-pb+1,blur,step:gStep(g)>sb.width}})()""")
    ok("карточка товара: белый верх с логотипом TB",r2["logo"] and r2["white"]=="rgb(255, 255, 255)",r2)
    ok("карточка товара: фото целиком в рамке, без размытого фона",r2["full"] and r2["whole"] and not r2["blur"],r2)
    ok("карточка товара: по краям видны соседние фото",r2["peek"] and r2["step"],r2)
    await pg.evaluate("pop()");await pg.wait_for_timeout(700)
    ok("после закрытия товара панель вкладок вернулась",await pg.evaluate("!document.querySelector('#tabbar').classList.contains('hide')"))
    await pg.fill("#uq","женские леггинсы до 150");await pg.dispatch_event("#uq","input");await pg.wait_for_timeout(400)
    ok("умный поиск понимает запрос",await pg.evaluate("!!document.querySelector('#smartBox .smartq')"))
    await pg.fill("#uq","");await pg.dispatch_event("#uq","input");await pg.wait_for_timeout(300)
    ok("очистка поиска возвращает каталог",await pg.evaluate("!document.querySelector('#homeBody').hidden"))
    ok("нет ошибок JavaScript",not errs,errs[:3])
    await b.close()
  bad=[r for r in RULES if not r[1]]
  for n,s,i in RULES:print(("✓" if s else "✗"),n,("" if s else i))
  print(f"\n{len(RULES)-len(bad)}/{len(RULES)} правил выполнено");sys.exit(1 if bad else 0)
asyncio.run(main())

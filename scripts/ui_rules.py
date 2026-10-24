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
    # плавность: в простое страница не пересчитывается каждый кадр (анимации — только transform/opacity)
    cdp=await ctx.new_cdp_session(pg);await cdp.send("Performance.enable")
    async def lay():
      r=(await cdp.send("Performance.getMetrics"))["metrics"];return {x["name"]:x["value"] for x in r}["LayoutCount"]
    await pg.evaluate("popAll();tab('catalog');showCatHome&&showCatHome()");await pg.wait_for_timeout(1500)
    a=await lay();await pg.wait_for_timeout(3000);n=await lay()-a
    ok("каталог в простое: без пересчёта страницы каждый кадр",n<30,f"{n:.0f} пересчётов за 3 с")
    t=await pg.evaluate("(async()=>{openBrand(Object.keys(P.reduce((m,p)=>(m[p.bk]=(m[p.bk]||0)+1,m),{})).sort((a,b)=>P.filter(p=>p.bk===b).length-P.filter(p=>p.bk===a).length)[0]);const t=performance.now();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return [Math.round(performance.now()-t),document.querySelectorAll('#bgrid .pc').length]})()")
    ok("страница бренда открывается быстро и порциями",t[1]<=48,t)
    await pg.evaluate("popAll()")
    await pg.evaluate("popAll();tab('catalog');showCatHome()");await pg.wait_for_timeout(600)
    r3=await pg.evaluate("(()=>{const v=s=>{const e=document.querySelector(s);return !!e&&e.offsetParent!==null};return {optix:v('#homeBody [data-act=optixapp]'),gifts:v('#homeBody [data-act=gifts]'),legacy:[...document.querySelectorAll('#homeBody>.nwhide')].some(e=>e.offsetParent!==null)}})()")
    ok("каталог как в концепте: баннеры OPTIX и «Подарки», старых блоков нет",r3["optix"] and r3["gifts"] and not r3["legacy"],r3)
    await pg.evaluate("document.querySelector('#homeBody [data-act=gifts]').click()");await pg.wait_for_timeout(800)
    ok("«Подарки любимым» открывают подборку",await pg.evaluate("document.querySelector('#itemsTitle').textContent==='Подарки любимым'&&document.querySelectorAll('#grid .pc').length>0"))
    await pg.evaluate("showCatHome()")
    import re as _re; _css="".join(_re.findall(r"<style[^>]*>(.*?)</style>",open(__file__.replace("scripts/ui_rules.py","index.html")).read(),_re.S))
    ok("в стилях нет :has() (на iPhone тормозит всю страницу)",":has(" not in _css)
    # страж: подписка на большой бренд не должна раздувать страницу (на телефоне владельца было 48 000 элементов)
    big=await pg.evaluate("Object.entries(P.reduce((m,p)=>(m[p.bk]=(m[p.bk]||0)+1,m),{})).sort((a,b)=>b[1]-a[1])[0][0]")
    await pg.evaluate(f"follows.add('{big}');renderFeedFollow();renderCatHome&&renderCatHome()");await pg.wait_for_timeout(500)
    dn=await pg.evaluate("[document.getElementsByTagName('*').length,document.images.length]")
    ok("подписка на большой бренд не раздувает страницу",dn[0]<8000 and dn[1]<400,dn)
    await pg.evaluate(f"follows.delete('{big}');renderFeedFollow()")
    ok("нет ошибок JavaScript",not errs,errs[:3])
    await b.close()
  bad=[r for r in RULES if not r[1]]
  for n,s,i in RULES:print(("✓" if s else "✗"),n,("" if s else i))
  print(f"\n{len(RULES)-len(bad)}/{len(RULES)} правил выполнено");sys.exit(1 if bad else 0)
asyncio.run(main())

// Проверка витрины в браузере на пробных товарах: лента, каталог, раздел, бренд, карточка — без ошибок и с фото. Запуск: node scripts/smoke.cjs index.html <папка для снимков>
const {chromium}=require('playwright');const fs=require('fs');const html=fs.readFileSync(process.argv[2],'utf8');
(async()=>{const br=await chromium.launch();const t=await br.newPage({viewport:{width:600,height:900}});await t.setContent('<body style="margin:0"><div style="width:600px;height:900px;background:linear-gradient(#c8a,#358)"></div></body>');const img=await t.screenshot();
const prods=[];const B=["Dior","Brunello Cucinelli","Sporty & Rich","Loro Piana"];for(let i=0;i<80;i++){const b=B[i%4];prods.push({id:"p"+i,brand:b,bk:b.toLowerCase().replace(/\W/g,""),title:["Bag","Sneaker","Coat","Ring"][i%4]+" "+i,cat:["bags","shoes","clothing","jewelry"][i%4],g:i%2?"m":"w",price:{ua:900+i*30,eu:1,dxb:1},availability:"online",isNew:i%2==0,na:new Date().toISOString().slice(0,10),im:["https://cdn.sanity.io/images/a/b/i"+i+".jpg","https://cdn.sanity.io/images/a/b/j"+i+".jpg"],sizes:[{size:"M",status:"online"}],colors:[]})}
const coll=[{id:"c1",brand:"Dior",title:"Cruise",ids:["p0","p4"],n:2,cover:"https://cdn.sanity.io/images/a/b/c.jpg"}];
const p=await br.newPage({viewport:{width:390,height:844}});const errs=[];p.on("pageerror",e=>errs.push(e.message));
await p.route("**/*",async r=>{const u=r.request().url();if(u.startsWith("http://t.local/api/catalog"))return r.fulfill({contentType:"application/json",body:JSON.stringify({products:prods,collections:coll,content:{banners:[],rails:[{id:"r",title:"Сумки до 3 000 €",rule:"category",value:"bags",maxPrice:3000}],news:[],stories:[],site:{optix:{on:true}}}})});if(u.startsWith("http://t.local/api/"))return r.fulfill({status:404,body:"{}"});if(u==="http://t.local/")return r.fulfill({contentType:"text/html",body:html});if(/sanity/.test(u))return r.fulfill({contentType:"image/png",body:img,headers:{"access-control-allow-origin":"*"}});return r.continue()});
await p.addInitScript(()=>{localStorage.setItem("tb_signed","1");localStorage.setItem("tb_sp","1")});
await p.goto("http://t.local/");await p.waitForTimeout(2500);await p.evaluate(()=>document.querySelectorAll(".gate,#splash").forEach(x=>x.remove()));
const shot=async n=>{await p.waitForTimeout(700);await p.screenshot({path:process.argv[3]+"/s_"+n+".png"})};
const broken=()=>p.evaluate(()=>[...document.querySelectorAll("img")].filter(i=>i.offsetParent&&i.complete&&!i.naturalWidth&&i.getAttribute("src")).length);
const out={};
await shot("feed");out.feed=await broken();
await p.evaluate(()=>document.querySelector('[data-hg="m"]').click());await shot("feedm");
await p.evaluate(()=>tab("catalog"));await shot("cat");out.cat=await broken();
await p.evaluate(()=>document.querySelector('#cvSeg button[data-g="w"]').click());await shot("catw");
await p.evaluate(()=>{clearFilters();F.cats.add("bags");showItems("Сумки")});await shot("items");out.items=await broken();
await p.evaluate(()=>openBrand("dior"));await shot("brand");
await p.evaluate(()=>openProduct("p0"));await shot("card");out.card=await p.evaluate(()=>{const im=document.querySelector("#pvg img");return im&&im.classList.contains("geo")});
await p.evaluate(()=>{try{openCart()}catch(e){}});await shot("cart");
await p.evaluate(()=>{try{openColls()}catch(e){}});await shot("colls");
out.catPics=await p.evaluate(()=>{tab("catalog");return [...document.querySelectorAll(".cvn .pic,.cvnv .st span")].every(e=>getComputedStyle(e).backgroundImage!=="none")});const bad=errs.length||out.feed||out.cat||out.items||!out.card||!out.catPics;console.log(bad?"SMOKE FAIL":"SMOKE OK",errs,out);await br.close();process.exit(bad?1:0)})();

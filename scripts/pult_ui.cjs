// Пульт сотрудника в beta: открывается, заявки схемой, + Заявка со скрином (распознавание подменено), сохранение — без ошибок
const {chromium}=require('playwright');const fs=require('fs');const html=fs.readFileSync(process.argv[2],'utf8');const out=process.argv[3];
(async()=>{const br=await chromium.launch();const t=await br.newPage({viewport:{width:600,height:900}});await t.setContent('<body style="margin:0"><div style="width:600px;height:900px;background:linear-gradient(#ddd,#888)"></div></body>');const img=await t.screenshot({type:"jpeg"});fs.writeFileSync(out+"/shot.jpg",img);
const prods=[];for(let i=0;i<40;i++){const b=["Chanel","Dior"][i%2];prods.push({id:"product.p"+i,brand:b,bk:b.toLowerCase(),title:["Ankle Boots","Ballerinas","Lace-Up Boots","Mules"][i%4]+" "+i,cat:"shoes",g:"w",price:{ua:1200+i*40,eu:1,dxb:1},availability:"online",im:["https://cdn.sanity.io/images/a/b/i"+i+".jpg"],sizes:[{size:"38",status:"online"},{size:"39",status:"online"}],colors:[]})}
const now=Date.now(),iso=m=>new Date(now-m*6e4).toISOString();
const reqs=[{_id:"req.a",code:"K7Q2",stage:"new",createdAt:iso(500),who:{nick:"marina.kyiv"},want:{brand:"Chanel",type:"shoes",size:"38",budget:2000},by:"Дмитрий"},
 {_id:"req.b",code:"A1B2",stage:"offered",createdAt:iso(1500),who:{name:"Ирина"},want:{brand:"Louis Vuitton",model:"Neverfull MM",type:"bag"}},
 {_id:"req.c",code:"C3D4",stage:"found",createdAt:iso(1600),who:{nick:"kate.fit"},want:{brand:"Alo",type:"clothing",size:"S"}},
 {_id:"req.d",code:"E5F6",stage:"order",createdAt:iso(4000),who:{name:"Анна"},want:{brand:"Cartier",model:"Love",type:"jewelry",size:"17"}}];
let saved=null,weekSave=null;
const p=await br.newPage({viewport:{width:390,height:844}});const errs=[];p.on("pageerror",e=>errs.push(e.message));
await p.route("**/*",async r=>{const u=r.request().url(),m=r.request().method();
  if(u.startsWith("http://t.local/api/catalog"))return r.fulfill({contentType:"application/json",body:JSON.stringify({products:prods,collections:[],content:{banners:[],rails:[],news:[],stories:[],site:{}}})});
  if(u.startsWith("http://t.local/api/me")){let b={};try{b=JSON.parse(r.request().postData()||"{}")}catch(e){}
    if(b.a==="st"){const op=b.op;let j={};
      if(op==="pult")j={reqs,counts:{reqs:3,orders:12,approve:55,urgent:1},approvals:[{title:"LV · сумки",sub:"55 вещей",url:"https://claude.ai/x"}],tasks:[{t:"Дубли LV убрать",sub:"117 скрыто",st:"done"},{t:"Блок «Подарунки» — макет",sub:"до 25.11",st:"work"},{t:"Умные фильтры — выбрать",sub:"ждёт вас",st:"you"}],agents:[{n:"Ассортимент",s:"LV ✓"},{n:"Перевод",s:"ошибка",ok:false}],agentsAt:"ночь на 24.11"};
      if(op==="clients")j={clients:[{id:"customer.1",name:"Марина",username:"marina.kyiv",n:2},{id:"customer.2",name:"Анна",insta:"anna_k",n:1},{id:"customer.3",name:"Олена",username:"olena_s",n:0}]};
      if(op==="reqParse")j={guess:{brand:"chanel",type:"shoes",model:"",color:"Black",size:"38",budget:null,nick:"marina.kyiv",sure:{brand:true}}};
      if(op==="img")j={url:"https://cdn.sanity.io/images/a/b/up.jpg"};
      if(op==="reqNew"){saved=b.d;j={req:{_id:"req.new",...b.d,stage:"new",createdAt:new Date().toISOString(),code:"NEW1"}}}
      if(op==="reqSave")j={req:{}};if(op==="save"){weekSave=b.d;j={}}
      return r.fulfill({contentType:"application/json",body:JSON.stringify(j)})}
    return r.fulfill({contentType:"application/json",body:JSON.stringify({staff:true,beta:false,access:"ok",user:{id:1,name:"Дмитрий"},profile:{name:"Дмитрий"},orders:[]})})}
  if(u.startsWith("http://t.local/api/"))return r.fulfill({status:404,body:"{}"});
  if(u==="http://t.local/")return r.fulfill({contentType:"text/html",body:html});
  if(/sanity/.test(u))return r.fulfill({contentType:"image/jpeg",body:img,headers:{"access-control-allow-origin":"*"}});return r.continue()});
await p.addInitScript(()=>{localStorage.setItem("tb_signed","1");localStorage.setItem("tb_sp","1")});
await p.goto("http://t.local/");await p.waitForTimeout(2500);await p.evaluate(()=>document.querySelectorAll(".gate,#splash").forEach(x=>x.remove()));
await p.evaluate(async()=>{meCall=async b=>{const r=await fetch("/api/me",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})});return r.json()};try{await loadMe()}catch(e){}});
const res={staff:await p.evaluate(()=>isStaff())};
await p.evaluate(()=>openPult());await p.waitForTimeout(900);await p.screenshot({path:out+"/1_pult.png",fullPage:false});
res.rows=await p.evaluate(()=>document.querySelectorAll(".pu-req").length);
await p.evaluate(()=>document.querySelector(".pu").closest(".page,.scr,section,div").scrollTop=600);
await p.evaluate(()=>{const el=document.querySelector("#puTasks");el&&el.scrollIntoView()});await p.waitForTimeout(300);await p.screenshot({path:out+"/2_pult_bottom.png"});
await p.evaluate(()=>document.querySelector("[data-puadd]").click());await p.waitForTimeout(700);await p.screenshot({path:out+"/3_new.png"});
await p.setInputFiles("[data-pqf] >> nth=1",out+"/shot.jpg").catch(async()=>{const h=await p.$$("[data-pqf]");await h[1].setInputFiles(out+"/shot.jpg")});
await p.waitForTimeout(1500);await p.screenshot({path:out+"/4_parsed.png"});
res.brand=await p.evaluate(()=>document.querySelector("[data-pqb]").value);
res.matches=await p.evaluate(()=>document.querySelectorAll("[data-pqmt] .pq-mi").length);
await p.evaluate(()=>document.querySelector("[data-pqsave]").click());await p.waitForTimeout(800);
res.saved=saved;
await p.evaluate(()=>document.querySelector('[data-pureq="req.a"]').click());await p.waitForTimeout(700);await p.screenshot({path:out+"/5_card.png"});
await p.evaluate(()=>closeSheet&&closeSheet());await p.waitForTimeout(400);
await p.evaluate(()=>soOrder({_id:"lead.w",number:"1",status:"work",createdAt:new Date(Date.now()-9*864e5).toISOString(),items:[{name:"Bag",price:1000}],dest:"ua",delivery:{}},()=>{},[]));await p.waitForTimeout(600);
res.wk0=await p.evaluate(()=>document.querySelector(".so-wkr").innerText);
await p.evaluate(()=>document.querySelector("[data-sowk]").click());await p.waitForTimeout(200);
await p.screenshot({path:out+"/6_week.png"});
await p.evaluate(()=>document.querySelectorAll("[data-sowkto]")[1].click());await p.waitForTimeout(500);
res.wk1=await p.evaluate(()=>document.querySelector(".so-wkr").innerText);res.weekSave=weekSave;
res.errs=errs;console.log(JSON.stringify(res,null,1));await br.close()})();

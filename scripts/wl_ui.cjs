// Вишлисты в beta: публичная ссылка, подарок, статус, «Мої вішлісти», Пульт — без ошибок; скриншоты в папку
const {chromium}=require('playwright');const fs=require('fs');const html=fs.readFileSync(process.argv[2],'utf8');const out=process.argv[3];
(async()=>{const br=await chromium.launch();
const prods=[{id:"product.a",brand:"Louis Vuitton",bk:"louis vuitton",title:"Keepall Bandoulière 45",cat:"bags",g:"u",price:{ua:3780,eu:1,dxb:1},availability:"online",im:["https://cdn.sanity.io/images/a/b/i1.jpg"],sizes:[],colors:[]}];
const items=[{k:"k1",pid:"product.a",t:"Keepall Bandoulière 45",b:"Louis Vuitton",img:"https://cdn.sanity.io/images/a/b/i1.jpg",size:"",color:"",note:"мрію",prio:"want",price:3780,got:1200,left:2580,st:"part"},{k:"k2",pid:"product.b",t:"Cosmetic Pouch PM",b:"Louis Vuitton",img:"https://cdn.sanity.io/images/a/b/i2.jpg",price:800,got:800,left:0,st:"done"},{k:"k3",pid:"product.c",t:"Maire Short Down Jacket",b:"Moncler",img:"https://cdn.sanity.io/images/a/b/i3.jpg",size:"1",color:"Black",price:1595,got:0,left:1595,st:"wait"}];
const list={code:"abcdefgh",title:"Мій день народження",occasion:"birthday",date:"2026-12-12",opts:{part:true,anon:true},items,total:2000,people:6,gifts:[{k:"k1",amount:100,name:"Марія",msg:"З днем народження!"},{k:"k2",amount:800,anon:true,name:""}],pending:[{id:"g9",k:"k1",amount:2580,st:"link",link:"https://pay.example/x"}]};
let gift=null,set=[];
const p=await br.newPage({viewport:{width:390,height:844}});const errs=[];p.on("pageerror",e=>errs.push(e.message));
const img=fs.readFileSync(out+"/../pshot/shot.jpg");
await p.route("**/*",async r=>{const u=r.request().url();
  if(u.startsWith("http://t.local/api/catalog"))return r.fulfill({contentType:"application/json",body:JSON.stringify({products:prods,collections:[],content:{banners:[],rails:[],news:[],stories:[],site:{}}})});
  if(u.includes("/api/me?wl="))return r.fulfill({contentType:"application/json",body:JSON.stringify({code:"abcdefgh",title:"Мій день народження",occasion:"birthday",date:"2026-12-12",owner:"Анна",opts:{part:true,anon:true},items})});
  if(u.includes("/api/me?wlg="))return r.fulfill({contentType:"application/json",body:JSON.stringify({st:"link",amount:100,item:"Louis Vuitton — Keepall Bandoulière 45",link:"https://pay.example/abc",owner:"Анна"})});
  if(u.startsWith("http://t.local/api/me")){let b={};try{b=JSON.parse(r.request().postData()||"{}")}catch(e){}
    if(b.a==="wlGift"){gift=b.d;return r.fulfill({contentType:"application/json",body:JSON.stringify({token:"abcdefghjkmnpqrs",amount:100})})}
    if(b.a==="wl")return r.fulfill({contentType:"application/json",body:JSON.stringify({lists:[list],list,base:"https://t.me/bot?startapp=wl_"})});
    if(b.a==="st"){if(b.op==="wlQueue")return r.fulfill({contentType:"application/json",body:JSON.stringify({gifts:[{id:"g1",st:"new",amount:100,item:"Louis Vuitton — Keepall 45",name:"Марія",contact:"@maria_k",msg:"З днем!",wl:"abcdefgh",wlTitle:"Мій день народження",client:"Анна",at:new Date().toISOString()},{id:"g2",st:"new",amount:800,full:true,anon:true,item:"LV — Cosmetic Pouch PM",name:"Ольга",contact:"+380671112233",wl:"abcdefgh",wlTitle:"ДР",client:"Анна",at:new Date().toISOString()}],counts:{link:2,wait:1,check:1}})});
      if(b.op==="wlGiftSet"){set.push(b.d);return r.fulfill({contentType:"application/json",body:JSON.stringify({gift:{id:b.d.id,st:"link"}})})}
      return r.fulfill({contentType:"application/json",body:JSON.stringify({reqs:[],counts:{},tasks:[],agents:[],approvals:[]})})}
    return r.fulfill({contentType:"application/json",body:JSON.stringify({staff:true,beta:false,access:"ok",user:{id:1,name:"Анна"},profile:{name:"Анна"},orders:[]})})}
  if(u.startsWith("http://t.local/api/"))return r.fulfill({status:404,body:"{}"});
  if(u.startsWith("http://t.local/"))return r.fulfill({contentType:"text/html",body:html});
  if(/sanity/.test(u))return r.fulfill({contentType:"image/jpeg",body:img,headers:{"access-control-allow-origin":"*"}});return r.continue()});
await p.addInitScript(()=>{localStorage.setItem("tb_sp","1")});
await p.goto("http://t.local/?wl=abcdefgh");await p.waitForTimeout(3500);await p.evaluate(()=>document.querySelectorAll(".gate,#splash").forEach(x=>x.remove()));
await p.screenshot({path:out+"/w1_public.png"});
await p.evaluate(()=>document.querySelector("[data-wlg]").click());await p.waitForTimeout(600);
await p.evaluate(()=>{document.querySelector("[data-full='0']").click();document.querySelector("[data-am='100']").click();document.querySelector("#wgN").value="Марія";document.querySelector("#wgC").value="@maria_k"});await p.waitForTimeout(300);
await p.screenshot({path:out+"/w2_gift.png"});
await p.evaluate(()=>document.querySelector("[data-wgo]").click());await p.waitForTimeout(900);await p.screenshot({path:out+"/w3_status.png"});
await p.evaluate(async()=>{localStorage.setItem("tb_signed","1");meCall=async b=>{const r=await fetch("/api/me",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})});return r.json()};store.set("tb_login",{sess:"x",exp:Date.now()+1e9})});
await p.evaluate(()=>openWishlists());await p.waitForTimeout(900);await p.screenshot({path:out+"/w4_mine.png"});
await p.evaluate(()=>document.querySelector("[data-wlopen]").click());await p.waitForTimeout(800);await p.screenshot({path:out+"/w5_list.png"});
await p.evaluate(()=>openWlPult());await p.waitForTimeout(900);await p.screenshot({path:out+"/w6_pult.png"});
console.log(JSON.stringify({errs,gift},null,1));await br.close()})();

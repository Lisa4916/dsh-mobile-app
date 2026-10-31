const http = require('http');
function get(u){return new Promise((res,rej)=>{http.get(u,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res(b));}).on('error',rej);});}
(async()=>{
  const list = JSON.parse(await get('http://127.0.0.1:9222/json'));
  for (const t of list) console.log(t.type, '|', t.url, '|', t.title);
})();

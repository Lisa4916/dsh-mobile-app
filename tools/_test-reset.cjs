const http = require('http');
function get(u){return new Promise((res,rej)=>{http.get(u,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>res(b));}).on('error',rej);});}
class WS {
  constructor(url){ this.url=url; }
  connect(){ return new Promise((res,rej)=>{
    const u = new URL(this.url);
    const req = http.request({host:u.hostname,port:u.port,path:u.pathname+u.search,headers:{
      'Connection':'Upgrade','Upgrade':'websocket',
      'Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13'}});
    req.on('upgrade',(r,socket)=>{ this.socket=socket; this.buf=Buffer.alloc(0);
      socket.on('data',d=>{ this.buf=Buffer.concat([this.buf,d]); this._drain(); }); res(); });
    req.on('error',rej); req.end();
  });}
  _drain(){ while(true){ if(this.buf.length<2)return;
    const b2=this.buf[1]; let len=b2&0x7f, off=2;
    if(len===126){ if(this.buf.length<4)return; len=this.buf.readUInt16BE(2); off=4; }
    else if(len===127){ if(this.buf.length<10)return; len=Number(this.buf.readBigUInt64BE(2)); off=10; }
    if(this.buf.length<off+len)return;
    const payload=this.buf.slice(off,off+len); this.buf=this.buf.slice(off+len);
    try{ const s=JSON.parse(payload.toString('utf8')); if(s.id===this._waitId){ const cb=this._waitCb; this._waitId=null; this._waitCb=null; cb(s);} }catch(e){}
  }}
  send(obj){ const p=Buffer.from(JSON.stringify(obj));
    const mask=Buffer.from([0,0,0,0]); let head;
    if(p.length<126){ head=Buffer.from([0x81,0x80|p.length]); }
    else if(p.length<65536){ head=Buffer.alloc(4); head[0]=0x81; head[1]=0x80|126; head.writeUInt16BE(p.length,2);}
    else { head=Buffer.alloc(10); head[0]=0x81; head[1]=0x80|127; head.writeBigUInt64BE(BigInt(p.length),2);}
    this.socket.write(Buffer.concat([head,mask,p]));
  }
  cmd(id,method,params){ return new Promise(res=>{ this._waitId=id; this._waitCb=res; this.send({id,method,params}); setTimeout(()=>{ if(this._waitId===id){this._waitId=null;res({error:'timeout'});} },10000); }); }
}
(async()=>{
  const list = JSON.parse(await get('http://127.0.0.1:9222/json'));
  const t = list.find(x=>x.type==='page');
  const ws = new WS(t.webSocketDebuggerUrl); await ws.connect();
  let i=1;
  const q = async (e) => { const r = await ws.cmd(i++,'Runtime.evaluate',{expression:e,returnByValue:true}); return r.result && r.result.result && r.result.result.value; };
  console.log('BEFORE sessions.current =', await q("localStorage.getItem('dsh.sessions.current')"));
  console.log('BEFORE text head =', JSON.stringify((await q("document.body.innerText")).slice(0,120)));
  // 清掉恢复键，然后整页重载，观察前端会落在哪
  await q("localStorage.removeItem('dsh.sessions.current'); 'ok'");
  await q("location.reload(); 'reloaded'");
  await new Promise(r=>setTimeout(r, 9000));
  console.log('AFTER text head =', JSON.stringify((await q("document.body.innerText")).slice(0,200)));
  console.log('AFTER sessions.current =', await q("localStorage.getItem('dsh.sessions.current')"));
  console.log('AFTER hasComposer =', await q("!!document.querySelector('[contenteditable=\"true\"]')"));
  process.exit(0);
})();

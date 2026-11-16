import {useEffect,useState} from 'react';

export function usePagePresence(path:string,editable:boolean){
  const [shared,setShared]=useState(false);
  useEffect(()=>{
    setShared(false);
    if(!path||!editable||typeof crypto.randomUUID!=='function')return;
    const token=crypto.randomUUID();
    let live=true;
    let sending=false;
    const post=(leave=false)=>fetch('/api/note/presence',{
      method:'POST',keepalive:leave,headers:{'Content-Type':'application/json'},
      body:JSON.stringify({path,token,leave}),
    });
    const beat=async()=>{
      if(sending)return;
      sending=true;
      try{
        const response=await post();
        if(!response.ok)return;
        const {other}=await response.json() as {other:boolean};
        if(live)setShared(other);
      }catch{/* Loading and saving remain available if presence is unavailable. */}
      finally{sending=false;}
    };
    const leave=()=>void post(true).catch(()=>{});
    void beat();
    const timer=window.setInterval(beat,7000);
    window.addEventListener('pagehide',leave);
    return()=>{live=false;window.clearInterval(timer);window.removeEventListener('pagehide',leave);leave();};
  },[path,editable]);
  return shared;
}

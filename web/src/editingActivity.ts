let lastSignal=-Infinity;

/** Yield local background workers during writing without queuing network work per keystroke. */
export function reportEditingActivity(){
  const now=performance.now();
  if(now-lastSignal<1500)return;
  lastSignal=now;
  void fetch('/api/editing/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});
}

import {renderToString} from 'katex';

export interface PastedMathPart { text: string; math?: 'inline' | 'display' }

/** Recognise explicit LaTeX delimiters, leaving fenced/inline code and $ maths alone. */
export function pastedMathParts(text: string): PastedMathPart[] {
  const parts: PastedMathPart[] = []; let plain='',at=0;
  const keep=(s:string)=>{plain+=s;at+=s.length;};
  const flush=()=>{if(plain){parts.push({text:plain});plain='';}};
  while(at<text.length){
    const remaining=text.slice(at);
    // Skip complete fenced code, including tilde fences and longer backtick fences.
    if(at===0||text[at-1]==='\n'){
      const fence=/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(remaining);
      if(fence){
        const marker=fence[1][0],length=fence[1].length;
        const close=new RegExp(`^ {0,3}${marker==='`'?'`':'~'}{${length},}[ \\t]*(?:\\n|$)`,'gm');
        close.lastIndex=fence[0].length;const end=close.exec(remaining);
        keep(end?remaining.slice(0,end.index+end[0].length):remaining);continue;
      }
    }
    const code=/^`+/.exec(remaining);
    if(code){const end=text.indexOf(code[0],at+code[0].length);keep(end<0?code[0]:text.slice(at,end+code[0].length));continue;}
    if(text[at]==='$'&&text[at-1]!=='\\'){
      const marker=remaining.startsWith('$$')?'$$':'$';const end=text.indexOf(marker,at+marker.length);
      if(end>=0){keep(text.slice(at,end+marker.length));continue;}
    }
    const open=/^(\\{1,2})(\(|\[)/.exec(remaining);
    if(open&&text[at-1]!=='\\'){
      const close=open[1]+(open[2]==='('?')':']');const end=text.indexOf(close,at+open[0].length);
      if(end>=0){
        const body=text.slice(at+open[0].length,end).trim();
        const value=open[1].length===2?body.replace(/\\\\(?=[a-zA-Z])/g,'\\'):body;
        if(value&&value.length<=4096&&(!value.includes('\n')||open[2]==='[')&&!value.includes('$')){
          try{
            renderToString(value,{displayMode:open[2]==='[',throwOnError:true,strict:false,trust:false});
            flush();parts.push({text:value,math:open[2]==='['?'display':'inline'});at=end+close.length;continue;
          }catch{/* Keep malformed or unsupported source verbatim. */}
        }
      }
    }
    keep(text[at]);
  }
  flush();return parts;
}

export function normaliseMathPaste(text:string):string {
  return pastedMathParts(text).map(p=>p.math==='inline'?`$${p.text}$`:p.math==='display'?`\n\n$$\n${p.text}\n$$\n\n`:p.text).join('');
}

import {useEffect,useRef,useState} from 'react';
import type {DocumentSearch, NoteInfo, SearchHit} from './api';

type Options = {subjectOnly:boolean;titlesOnly:boolean;from:string;through:string};
type Results = {key:string;notes?:SearchHit[];documents?:DocumentSearch;noteError?:boolean;pdfError?:boolean};
const defaults:Options={subjectOnly:false,titlesOnly:false,from:'',through:''};

async function request<T>(route:string,params:URLSearchParams,signal:AbortSignal):Promise<T>{
  const response=await fetch(route+'?'+params,{signal});
  if(!response.ok)throw new Error('Search request failed');
  return response.json() as Promise<T>;
}
export function useLibrarySearch(query:string,subject:string,notes:readonly NoteInfo[],enabled=true){
  const [options,setOptions]=useState(defaults);
  const [live,setLive]=useState<Results|null>(null);
  const [returnAvailable,setReturnAvailable]=useState(false);
  const [restoreId,setRestoreId]=useState(0);
  const [refreshId,setRefreshId]=useState(0);
  const params=new URLSearchParams({q:query.trim(),fold:'1'});
  if(options.subjectOnly&&subject)params.set('subject',subject);
  const documentKey=params.toString();
  if(options.titlesOnly)params.set('titles','1');
  if(options.from)params.set('from',String(new Date(options.from+'T00:00:00').getTime()/1000));
  if(options.through){
    const next=new Date(options.through+'T00:00:00');
    next.setDate(next.getDate()+1);
    params.set('before',String(next.getTime()/1000));
  }
  const key=params.toString();
  const active=!!query.trim();
  const restore=useRef<{key:string;id:string;top:number}|null>(null);
  const capture=(item:HTMLElement,list:HTMLElement|null)=>{
    if(!list||!item.dataset.searchItem)return;
    restore.current={key,id:item.dataset.searchItem,top:list.scrollTop};
    setReturnAvailable(true);
  };
  useEffect(()=>{
    setReturnAvailable(false);
    restore.current=null;
  },[key]);
  useEffect(()=>{
    if(!active||!enabled)return;
    const cancel=new AbortController();
    const publish=(entry:Partial<Results>)=>{
      if(!cancel.signal.aborted)setLive(previous=>({...((previous?.key===key)?previous:{key}),...entry}));
    };
    const start=window.setTimeout(()=>{
      void request<SearchHit[]>('/api/search',new URLSearchParams(key),cancel.signal).then(notes=>publish({notes,noteError:false}),()=>publish({notes:[],noteError:true}));
      if(!options.titlesOnly)void request<DocumentSearch>('/api/documents/search',new URLSearchParams(documentKey),cancel.signal).then(documents=>publish({documents,pdfError:!documents.available}),()=>publish({pdfError:true}));
    },150);
    return()=>{cancel.abort();window.clearTimeout(start);};
  },[active,documentKey,key,notes,options.titlesOnly,refreshId,enabled]);
  return {options,setOptions,results:active&&live?.key===key?live:null,restore,restoreId,capture,returnAvailable,requestReturn:()=>setRestoreId(id=>id+1),refresh:()=>setRefreshId(id=>id+1),key};
}
export type LibrarySearch=ReturnType<typeof useLibrarySearch>;

export function searchTerms(query:string):string[]{
  return Array.from(query.matchAll(/"([^"]+)"|(\S+)/gu),match=>match[1]??match[2])
    .filter(term=>!!term&&term!=='OR'&&!term.startsWith('-')&&!/^(?:tag|folder|path):/u.test(term));
}

const extra:Record<string,string>={ø:'o',æ:'ae',œ:'oe',ł:'l',ß:'ss'};
export function searchFold(text:string){
  return text.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').replace(/[øæœłß]/gu,char=>extra[char]);
}

export function matchingParts(text:string,query:string):{text:string;hit:boolean}[]{
  const terms=searchTerms(query).map(searchFold).filter(Boolean);
  let plain='';
  const starts:number[]=[],ends:number[]=[];
  let offset=0;
  for(const char of text){
    const folded=searchFold(char);
    plain+=folded;
    for(let i=0;i<folded.length;i++){
      starts.push(offset);
      ends.push(offset+char.length);
    }
    offset+=char.length;
  }
  const ranges:{from:number;to:number}[]=[];
  for(const term of terms){
    let from=0;
    while((from=plain.indexOf(term,from))>=0){
      ranges.push({from:starts[from],to:ends[from+term.length-1]});
      from+=term.length;
    }
  }
  ranges.sort((a,b)=>a.from-b.from||b.to-a.to);
  const spans:{from:number;to:number}[]=[];
  for(const range of ranges){
    const last=spans[spans.length-1];
    if(last&&last.to>=range.from)last.to=Math.max(range.to,last.to);
    else spans.push(range);
  }
  const parts:{text:string;hit:boolean}[]=[];
  let at=0;
  for(const span of spans){
    if(span.from>at)parts.push({text:text.slice(at,span.from),hit:false});
    parts.push({text:text.slice(span.from,span.to),hit:true});
    at=span.to;
  }
  if(at<text.length)parts.push({text:text.slice(at),hit:false});
  return parts;
}

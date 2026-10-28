/** Parse Excel/CSV clipboard rows locally; no formulas are executed. */
export function parseTable(source:string):string[][] {
  if(source.length>120_000)throw Error('Paste at most 100 rows and 20 columns.');
  let quoted=false,tabbed=false;
  for(const c of source){if(c==='"')quoted=!quoted;else if(!quoted&&c==='\t')tabbed=true;else if(!quoted&&c==='\n')break;}
  const separator=tabbed?'\t':',';
  const rows:string[][]=[];let row:string[]=[],value='';quoted=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(c==='"'&&(quoted||value==='')){if(quoted&&source[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===separator||c==='\n'||c==='\r')){
      row.push(value);value='';if(c!==separator){if(c==='\r'&&source[i+1]==='\n')i++;rows.push(row);row=[];}
    }else value+=c;
  }
  if(quoted)throw Error('Close the quotation marks in your pasted table.');
  if(value||row.length)rows.push([...row,value]);
  while(rows.length&&rows[rows.length-1].every(v=>!v.trim()))rows.pop();
  const columns=Math.max(0,...rows.map(r=>r.length));
  if(!rows.length||rows.length>100||columns>20)throw Error('Use between 1 and 100 rows, and up to 20 columns.');
  return rows.map(r=>Array.from({length:columns},(_,i)=>r[i]??''));
}
const escapeCell=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\/g,'\\\\').replace(/([|*_[\]`])/g,'\\$1').replace(/\r?\n/g,'<br>');
export function tableMarkdown(rows:number,columns:number,paste=''):string {
  const data=paste.trim()?parseTable(paste):null;
  if(!Number.isSafeInteger(rows)||rows<1||rows>100||!Number.isSafeInteger(columns)||columns<1||columns>20)throw Error('Choose 1–100 rows and 1–20 columns.');
  const grid=data??Array.from({length:rows},()=>Array.from({length:columns},()=>''));
  const line=(row:string[])=>'| '+row.map(escapeCell).join(' | ')+' |';
  return [line(grid[0]),'| '+grid[0].map(()=> '---').join(' | ')+' |',...grid.slice(1).map(line)].join('\n')+'\n';
}

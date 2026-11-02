export const PAGE_FONTS={default:'',serif:'Georgia, "Times New Roman", serif',sans:'"Segoe UI", Arial, sans-serif',mono:'Consolas, "Courier New", monospace'};
export interface PageStyle {font:keyof typeof PAGE_FONTS;size:number}
export function pageStyle(meta:Record<string,unknown>):PageStyle{
  const raw=meta.documentStyle as Partial<PageStyle>|undefined;
  return {font:raw?.font&&Object.prototype.hasOwnProperty.call(PAGE_FONTS,raw.font)?raw.font:'default',size:[14,16,18,20,24].includes(Number(raw?.size))?Number(raw?.size):0};
}
export function wordCount(markdown:string):number{
  return (markdown.replace(/^---\n[\s\S]*?\n---\n/,'').replace(/!\[\[[\s\S]*?\]\]|!\[[^\]]*\]\([^)]*\)/g,'').replace(/<[^>]+>/g,' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)??[]).length;
}

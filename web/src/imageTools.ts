export const IMAGE_LIMIT = 20 * 1024 * 1024;
export type ImageCrop={left:number;right:number;top:number;bottom:number};
export const noImageCrop:ImageCrop={left:0,right:0,top:0,bottom:0};
export const imageAlias=(value:string)=>value.replace(/[[\]|\n\r]/g,' ').replace(/\s+/g,' ').trim().slice(0,220);

export function imageSourceCrop(width:number,height:number,crop:ImageCrop) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw Error('This image could not be read.');
  const pct=(amount:number)=>Number.isFinite(amount)?Math.max(0,Math.min(45,amount))/100:0;
  const x=Math.floor(width*pct(crop.left)),y=Math.floor(height*pct(crop.top));
  return {x,y,width:Math.max(1,Math.round(width*(1-pct(crop.right)))-x),height:Math.max(1,Math.round(height*(1-pct(crop.bottom)))-y)};
}

export async function imageDerivative(source:HTMLImageElement,crop:ImageCrop,turns:number) {
  const part=imageSourceCrop(source.naturalWidth,source.naturalHeight,crop);
  const rotate=((turns%4)+4)%4;
  if(part.width*part.height>32_000_000)throw Error('This image is too large to edit here. Crop or resize it first, or insert the original.');
  const canvas=document.createElement('canvas');
  canvas.width=rotate%2?part.height:part.width;canvas.height=rotate%2?part.width:part.height;
  const context=canvas.getContext('2d');
  if(!context)throw Error('Image editing is unavailable.');
  context.translate(canvas.width/2,canvas.height/2);context.rotate(rotate*Math.PI/2);
  context.drawImage(source,part.x,part.y,part.width,part.height,-part.width/2,-part.height/2,part.width,part.height);
  return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('The edited image could not be saved.')),'image/png'));
}

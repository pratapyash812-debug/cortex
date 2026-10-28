/** Writers retain their own drafts; backups and exports await their acknowledgements. */
const writers=new Map<string,()=>Promise<void>>();
export function registerSaveBarrier(key:string,flush:()=>Promise<void>){writers.set(key,flush);}
export async function flushOtherSaves(){for(const flush of writers.values())await flush();}

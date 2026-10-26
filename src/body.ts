// Bound streamed bodies as well as Content-Length; JSON payloads must fit the storage budget.
export async function readObject(request:Request):Promise<Record<string,unknown>|null> {
 const reader=request.body?.getReader(); if(!reader) return null;
 let length=0;const chunks:Uint8Array[]=[];
 try {
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>131072){await reader.cancel();return null;}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const value=JSON.parse(new TextDecoder().decode(bytes));
  return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
 } catch {return null;}
}

// Measure UTF-8 payload sizes, never store or return any actual payload.
// Relay wire size is measured by the caller on the already serialized frame.
// These are transport measurements, NOT model-token counts.
export function mcpPayloadSizes(args,result) {
  const encoder=new TextEncoder();
  const bytes=value=>encoder.encode(value).length;
  const json=value=>JSON.stringify(value??null);
  const structured=result?.structuredContent===undefined?null:json(result.structuredContent);
  let textBytes=0,duplicateBytes=0;
  for(const item of Array.isArray(result?.content)?result.content:[]) {
    if(item?.type!=="text"||typeof item.text!=="string")continue;
    const n=bytes(item.text);textBytes+=n;
    if(structured!==null&&item.text===structured)duplicateBytes+=n;
  }
  return {requestBytes:bytes(json(args)),resultBytes:bytes(json(result)),textBytes,
    structuredBytes:structured===null?0:bytes(structured),duplicateBytes};
}

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

// Public cloud MCP only: structuredContent remains authoritative.
// Keep independent text, images, audio, resource links, error details and UI
// metadata untouched. Local MCP/Codex retains its compatibility representation.
export function compactMcpResult(result) {
  if (!result || result.isError || result.structuredContent?.error || result._meta ||
      result.structuredContent == null || !Array.isArray(result.content)) return result;
  const json=JSON.stringify(result.structuredContent);
  const content=result.content.filter(item=>!(item?.type==="text" && item.text===json &&
    Object.keys(item).every(key=>key==="type" || key==="text")));
  if(content.length===result.content.length)return result;
  return {...result,content:content.length?content:[{type:"text",text:"Result in structuredContent."}]};
}

// Only an Extension-created, nonce-bound setup tab may enroll. Credentials are
// returned privately by executeScript, never window.postMessage or page DOM.
if (location.origin==='https://rtube.win' && location.pathname==='/connect-extension' && document.body?.dataset.page==='extension-connect') {
  const nonce=new URL(location.href).searchParams.get('nonce');
  if(/^[a-f0-9-]{72}$/.test(nonce || ''))chrome.runtime.sendMessage({type:'researchtube_server_enroll',nonce}).then(result=>{
    const status=document.getElementById('status');
    if(status)status.textContent=result?.ok?'This Chrome profile is connected. You can close this tab.':'Could not connect this Chrome profile. '+(result?.errorCode==='EXTENSION_NOT_ALLOWED'?'Add this Extension ID to the server allowlist, then retry from Settings.':'Retry from ResearchTube Settings.');
  }).catch(()=>{});
}

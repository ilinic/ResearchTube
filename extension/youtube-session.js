// MAIN-world only. Session material never crosses the page bridge.
export async function sessionRequestOptions(input, init, environment) {
  const url = new URL(typeof input === "string" ? input : input.url || input.href, environment.origin);
  if (url.origin !== "https://www.youtube.com") throw Error("YouTube session requests must stay on www.youtube.com");
  const headers = new Headers(init.headers || input?.headers);
  headers.delete("Cookie"); // The browser owns cookies, including HttpOnly cookies.
  let body = init.body;
  if (url.pathname.startsWith("/youtubei/v1/")) {
    const account = environment.config("SESSION_INDEX");
    headers.set("X-Goog-AuthUser", String(Number.isInteger(Number(account)) ? Number(account) : 0));
    const delegated = environment.config("DELEGATED_SESSION_ID");
    if (typeof delegated === "string" && delegated) headers.set("X-Goog-PageId", delegated);
    if (environment.config("LOGGED_IN") === true) {
      // Generate the same short-lived origin-bound authorization used by WEB.
      // Read only the signing cookie; never persist or return it.
      const cookies = environment.cookies();
      const read = name => cookies.split(";").map(part => part.trim()).find(part => part.startsWith(name + "="))?.slice(name.length + 1);
      const sid = read("SAPISID") || read("__Secure-3PAPISID") || read("__Secure-1PAPISID");
      if (!sid) throw Error("YouTube session signing state is unavailable; reload YouTube and sign in again");
      const timestamp = Math.floor(Date.now() / 1000);
      const bytes = new TextEncoder().encode(`${timestamp} ${sid} ${environment.origin}`);
      const digest = await crypto.subtle.digest("SHA-1", bytes);
      const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      headers.set("Authorization", `SAPISIDHASH ${timestamp}_${hash}`);
      headers.set("X-Origin", environment.origin);
    }
    if (typeof body === "string" && headers.get("Content-Type")?.includes("application/json")) {
      const data = JSON.parse(body);
      if (data.context) {
        const user = environment.config("INNERTUBE_CONTEXT")?.user || {};
        data.context.user = { ...data.context.user, ...user, ...(delegated ? { onBehalfOfUser: delegated } : {}) };
        body = JSON.stringify(data);
      }
    }
  }
  return { ...init, headers, ...(body !== undefined ? { body } : {}), credentials: "include", redirect: "manual" };
}

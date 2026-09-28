    (() => {
      const image = document.getElementById("image"), video = document.getElementById("video"), audio = document.getElementById("audio"), kind = document.getElementById("kind"), status = document.getElementById("status"), path = document.getElementById("path"), refresh = document.getElementById("refresh"), copy = document.getElementById("copy");
      const runtimeAvailable = Boolean(globalThis.chrome?.runtime?.sendMessage);
      const extensionVersion = globalThis.chrome?.runtime?.getManifest?.().version || "unavailable";
      console.info(`[ResearchTube media] viewer script active version=${extensionVersion} runtime=${runtimeAvailable}`);
      window.parent.postMessage({ source: "researchtube-extension-media-viewer", type: "script-active", version: extensionVersion, runtimeAvailable }, "*");
      let media;
      try { media = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch (_error) { media = null; }
      const valid = media && typeof media.workspacePath === "string" && ["image", "video", "audio"].includes(media.mediaKind) && typeof media.mimeType === "string";
      console.info(`[ResearchTube media] viewer document active valid=${Boolean(valid)} kind=${media?.mediaKind || "unknown"}`);
      const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle("error", error); };
      const send = message => chrome.runtime.sendMessage(message);
      const element = () => media.mediaKind === "video" ? video : media.mediaKind === "audio" ? audio : image;
      function hideMedia() { for (const item of [image, video, audio]) { item.style.display = "none"; if (item !== image) { item.pause(); item.removeAttribute("src"); item.load(); } } }
      async function load() {
        if (!valid) { setStatus("The media anchor is invalid.", true); return; }
        refresh.disabled = true; copy.disabled = true; hideMedia(); path.textContent = media.workspacePath; kind.textContent = media.mediaKind === "video" ? "Workspace Video" : media.mediaKind === "audio" ? "Speech / Workspace Audio" : "Workspace Image"; setStatus("Loading media…");
        try {
          const response = await send({ type: "researchtube_media_viewer_resolve", path: media.workspacePath });
          if (!response?.ok || typeof response.data?.localAgentImageUrl !== "string") {
            console.error(`[ResearchTube media] local resolve failed code=${response?.errorCode || "unknown"}`);
            throw new Error(String(response?.error || "The Local Agent could not provide this media."));
          }
          const target = element();
          await new Promise((resolve, reject) => { const loaded = media.mediaKind === "image" ? "load" : "loadedmetadata"; const clear = () => { target.removeEventListener(loaded, onload); target.removeEventListener("error", onerror); }; const onload = () => { clear(); resolve(); }; const onerror = () => { clear(); reject(new Error("The local media could not be loaded.")); }; target.addEventListener(loaded, onload, { once: true }); target.addEventListener("error", onerror, { once: true }); target.src = `${response.data.localAgentImageUrl}${response.data.localAgentImageUrl.includes("?") ? "&" : "?"}viewer=${Date.now()}`; if (media.mediaKind !== "image") target.load(); });
          target.style.display = "block"; setStatus("");
          console.info(`[ResearchTube media] local media loaded kind=${media.mediaKind}`);
        } catch (error) {
          console.error(`[ResearchTube media] local media load failed: ${error instanceof Error ? error.message : "unknown error"}`);
          setStatus(error instanceof Error ? error.message : "The local media could not be loaded.", true);
        }
        finally { refresh.disabled = false; copy.disabled = false; }
      }
      refresh.addEventListener("click", () => void load());
      copy.addEventListener("click", async () => { if (!valid) return; copy.disabled = true; try { const response = await send({ type: "researchtube_capture_frame_local_action", action: "copyPath", path: media.workspacePath }); if (!response?.ok) throw new Error(String(response?.error || "Could not copy the workspace path.")); setStatus("Workspace path copied."); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not copy the workspace path.", true); } finally { copy.disabled = false; } });
      void load();
    })();

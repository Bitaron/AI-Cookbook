// Runtime for the static ~/.learn/index.html library.
import { mountLibrary, type Meta } from "./library";
import { initTheme } from "./ui";

const data = JSON.parse(document.getElementById("library-data")!.textContent || "{}") as { lessons: Meta[]; port: number };
initTheme();

(async () => {
  let serverUp = false;
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1000);
    serverUp = (await fetch(`http://127.0.0.1:${data.port}/health`, { signal: ctl.signal })).ok;
  } catch { /* offline */ }
  mountLibrary(document.querySelector<HTMLElement>(".library")!, data.lessons, {
    live: false, serverUp, port: data.port, hrefOffline: id => `lessons/${encodeURIComponent(id)}/lesson.html`,
  });
})();

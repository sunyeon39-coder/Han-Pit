/** GitHub Pages 서브경로(/Han-Pit/)·PWA 에서 상대 ./assets 가 깨지는 문제 방지 */

export function getAppBasePath() {
  if (typeof location === "undefined") return "/";
  const path = String(location.pathname || "/");
  const slash = path.lastIndexOf("/");
  if (slash < 0) return "/";
  return path.slice(0, slash + 1);
}

export function resolveAppAssetUrl(relative = "") {
  const rel = String(relative || "").replace(/^\.\//, "");
  if (typeof location === "undefined") return `./${rel}`;
  return `${location.origin}${getAppBasePath()}${rel}`;
}

export function resolveAppWordmarkUrl(buildTag = "") {
  const tag = String(buildTag || "").trim();
  const q = tag ? `?v=${encodeURIComponent(tag)}` : "";
  return `${resolveAppAssetUrl("icons/han-pit-wordmark.png")}${q}`;
}

export function applyAppMarkImages(buildTag = "") {
  if (typeof document === "undefined") return;
  const url = resolveAppWordmarkUrl(buildTag);
  document.querySelectorAll("img.app-mark-img").forEach((img) => {
    if (img.getAttribute("src") !== url) img.setAttribute("src", url);
  });
}

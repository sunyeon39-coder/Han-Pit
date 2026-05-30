const prefetched = new Set();

/** 같은 URL 은 한 번만 prefetch (페이지 전환 전 백그라운드 로드) */
export function prefetchPageOnce(href) {
  const url = String(href || "").trim();
  if (!url || prefetched.has(url)) return;
  prefetched.add(url);
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "document";
  link.href = url;
  document.head.appendChild(link);
}

// Ненавязчивый бейдж над заменёнными картинками: появляется при наведении,
// одна кнопка — переключить эту картинку между «твоё лицо» и оригиналом.
// Всё в Shadow DOM, чтобы стили сайта и наши не влияли друг на друга.

const STYLE = `
  :host { all: initial; }
  .pill {
    display: inline-flex; align-items: center; gap: 8px;
    font: 500 11px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
    background: rgba(255,255,255,.92); color: #111;
    border: 1px solid rgba(0,0,0,.08); border-radius: 999px;
    padding: 5px 6px 5px 10px;
    box-shadow: 0 2px 10px rgba(0,0,0,.14);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    user-select: none; white-space: nowrap;
  }
  .wm { letter-spacing: .02em; opacity: .7; }
  .btn {
    font: inherit; cursor: pointer;
    background: #111; color: #fff; border: 0; border-radius: 999px;
    padding: 4px 10px;
  }
  .btn:hover { background: #000; }
  @media (prefers-color-scheme: dark) {
    .pill { background: rgba(28,28,30,.92); color: #f5f5f7; border-color: rgba(255,255,255,.12); }
    .btn { background: #f5f5f7; color: #111; }
  }
  [hidden] { display: none !important; }
`;

let host = null;
let pill = null;
let btn = null;
let currentImg = null;
let hideTimer = null;
let rafPending = false;
let onToggle = null;

/**
 * @param {(img: HTMLImageElement) => "orig" | "swap"} toggleCallback
 *   переключает картинку и возвращает новое состояние показа
 */
export function initBadge(toggleCallback) {
  onToggle = toggleCallback;
  if (host) return;

  host = document.createElement("div");
  host.style.cssText =
    "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${STYLE}</style>
    <div class="pill" hidden><span class="wm">Face Fit</span><button class="btn" type="button"></button></div>`;
  pill = shadow.querySelector(".pill");
  btn = shadow.querySelector(".btn");
  pill.style.pointerEvents = "auto";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentImg && onToggle) setLabel(onToggle(currentImg));
  });
  pill.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  pill.addEventListener("mouseleave", scheduleHide);

  (document.body || document.documentElement).appendChild(host);

  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mouseout", onOut, true);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
}

export function hideBadge() {
  clearTimeout(hideTimer);
  if (pill) pill.hidden = true;
  currentImg = null;
}

function onOver(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.facefitDone !== "1") return;
  clearTimeout(hideTimer);
  currentImg = img;
  setLabel(img.dataset.facefitShown === "orig" ? "orig" : "swap");
  pill.hidden = false;
  reposition();
}

function onOut(e) {
  if (e.target === currentImg) scheduleHide();
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    pill.hidden = true;
    currentImg = null;
  }, 140);
}

function setLabel(shown) {
  btn.textContent = shown === "orig" ? "вернуть лицо" : "оригинал";
}

function reposition() {
  if (!currentImg || pill.hidden || rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!currentImg || pill.hidden) return;
    const r = currentImg.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) {
      pill.hidden = true;
      currentImg = null;
      return;
    }
    const x = Math.round(r.left + 8);
    const y = Math.round(r.bottom - 8 - pill.offsetHeight);
    host.style.transform = `translate(${x}px, ${y}px)`;
  });
}

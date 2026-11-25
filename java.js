/* ==========================================================
   SecureCampus - Playback add-on
   - "Last 5 hours" recorded footage with timeline scrubber
   - "Stored (2-10 days)" archive browser (hourly clips per day)
   NOTE: Simulated footage (demo). Real use needs NVR/HLS backend.
   ========================================================== */
(function () {
  "use strict";
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const pad = (n) => String(n).padStart(2, "0");
  const H = 3600000, D = 86400000;

  /* ---------- Cameras (same names as main app) ---------- */
  const CAMS = [];
  ["1st Floor", "2nd Floor"].forEach((f, fi) =>
    ["Room 1", "Room 2", "Room 3", "Room 4", "Hallway"].forEach((r, i) =>
      CAMS.push({ id: fi * 5 + i + 1, name: f + " - " + r })));

  /* Deterministic "is there a recording in this hour?" (demo gaps) */
  const hasRec = (camId, ms) => (camId * 7 + Math.floor(ms / H)) % 13 !== 0;
  const clipSize = (camId, ms) => (350 + ((camId * 53 + Math.floor(ms / H) * 17) % 260));
  const fmtDT = (ms) => new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const fmtHM = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const retention = () => { try { return (JSON.parse(localStorage.getItem("cctv_privacy")) || {}).retention || 30; } catch (e) { return 30; } };

  /* ---------- State ---------- */
  const S = { tab: "recent", cam: 1, day: 2, start: Date.now() - 5 * H, dur: 5 * 3600, pos: 0, playing: false, speed: 1, clipKey: null };

  /* ---------- Inject CSS ---------- */
  const css = document.createElement("style");
  css.textContent = `
  #view-playback .pb-ctrls{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:.8rem}
  #view-playback .pb-ctrls select{width:auto;padding:.45rem .6rem}
  #pbSlider{width:100%;margin-top:.8rem}
  .pb-time{display:flex;justify-content:space-between;font-size:.8rem;color:var(--muted);font-variant-numeric:tabular-nums;margin-top:.3rem}
  .pb-list{max-height:520px;overflow:auto}
  .pb-item{display:flex;justify-content:space-between;align-items:center;gap:.6rem;width:100%;text-align:left;padding:.65rem .8rem;margin-bottom:.4rem;border:1px solid var(--line);border-radius:10px;background:var(--panel2);font-size:.85rem;transition:border-color .2s}
  .pb-item:hover:not(:disabled){border-color:var(--primary)}
  .pb-item.active{border-color:var(--primary);background:rgba(59,130,246,.18)}
  .pb-item:disabled{opacity:.4;cursor:not-allowed}
  .pb-item small{color:var(--muted);display:block;font-size:.72rem}
  #pbDays{margin-bottom:.8rem}
  .chip:disabled{opacity:.4;cursor:not-allowed}
  `;
  document.head.appendChild(css);

  /* ---------- Inject UI ---------- */
  const section = document.createElement("section");
  section.className = "view";
  section.id = "view-playback";
  section.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="pbTabs">
        <button data-t="recent" class="active">Last 5 hours</button>
        <button data-t="archive">Stored footage (2&ndash;10 days)</button>
      </div>
      <select id="pbCam" style="width:auto"></select>
    </div>
    <div class="chips" id="pbDays" hidden></div>
    <p class="small muted" style="margin-top:0">Footage is simulated for demonstration. Connect to your NVR / recording server for real video.</p>
    <div class="grid-2" style="margin-top:.8rem">
      <div class="panel">
        <canvas class="feed" id="pbCanvas" width="960" height="540"></canvas>
        <input type="range" id="pbSlider" min="0" max="100" step="1" value="0" />
        <div class="pb-time"><span id="pbT0"></span><b id="pbNow" style="color:var(--text)"></b><span id="pbT1"></span></div>
        <div class="pb-ctrls">
          <button class="btn tiny" id="pbBack">&laquo; 10s</button>
          <button class="btn primary tiny" id="pbPlay">&#9654; Play</button>
          <button class="btn tiny" id="pbFwd">10s &raquo;</button>
          <select id="pbSpeed"><option value="1">1x</option><option value="2">2x</option><option value="4">4x</option><option value="8">8x</option><option value="16">16x</option></select>
          <button class="btn tiny" id="pbSnap" style="margin-left:auto">Snapshot</button>
        </div>
      </div>
      <div class="panel">
        <h2 id="pbListTitle"></h2>
        <div class="pb-list" id="pbList"></div>
      </div>
    </div>`;
  $(".content").appendChild(section);

  const navBtn = document.createElement("button");
  navBtn.className = "nav-btn";
  navBtn.dataset.view = "playback";
  navBtn.innerHTML = "<i>&#9199;</i> Playback";
  const logoutBtn = $("#sideNav");
  logoutBtn.appendChild(navBtn);

  /* Own navigation (main app's showView ignores unknown ids, so handle here) */
  navBtn.addEventListener("click", () => {
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-playback"));
    $$("#sideNav .nav-btn").forEach((b) => b.classList.toggle("active", b === navBtn));
    $("#pageTitle").textContent = "Playback";
    $("#sidebar").classList.remove("open");
    $("#scrim").classList.remove("show");
    window.scrollTo(0, 0);
    if (S.tab === "recent") enterRecent();
  });

  /* ---------- Camera select ---------- */
  $("#pbCam").innerHTML = CAMS.map((c) => `<option value="${c.id}">CAM ${pad(c.id)} - ${c.name}</option>`).join("");
  $("#pbCam").addEventListener("change", (e) => {
    S.cam = Number(e.target.value);
    S.tab === "recent" ? renderList() : renderList();
  });

  /* ---------- Tabs ---------- */
  $("#pbTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.tab = b.dataset.t;
    $$("#pbTabs button").forEach((x) => x.classList.toggle("active", x === b));
    S.tab === "recent" ? enterRecent() : enterArchive();
  });

  function enterRecent() {
    S.playing = false; S.clipKey = null;
    S.start = Date.now() - 5 * H;
    S.dur = 5 * 3600;
    S.pos = S.dur - 60; // start 1 minute before "now"
    $("#pbDays").hidden = true;
    renderList(); sync();
  }

  function enterArchive() {
    S.playing = false;
    $("#pbDays").hidden = false;
    const ret = retention();
    let html = "";
    for (let d = 2; d <= 10; d++) {
      const dt = new Date(Date.now() - d * D);
      const lbl = d + "d ago &middot; " + dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      const blocked = d > ret;
      html += `<button class="chip${d === S.day ? " active" : ""}" data-d="${d}" ${blocked ? 'disabled title="Deleted by retention policy"' : ""}>${lbl}</button>`;
    }
    $("#pbDays").innerHTML = html;
    if (S.day > ret) S.day = 2;
    S.clipKey = null; S.dur = 3600; S.pos = 0;
    S.start = dayStart(S.day);
    renderList(); sync();
  }
  $("#pbDays").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b || b.disabled) return;
    S.day = Number(b.dataset.d);
    $$("#pbDays .chip").forEach((c) => c.classList.toggle("active", c === b));
    S.clipKey = null; S.playing = false;
    renderList();
  });

  function dayStart(d) {
    const x = new Date(Date.now() - d * D);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  }

  /* ---------- Right-hand list ---------- */
  function renderList() {
    const list = $("#pbList");
    if (S.tab === "recent") {
      $("#pbListTitle").textContent = "Recorded segments (last 5 hours)";
      const ws = Date.now() - 5 * H, now = Date.now();
      let t = ws, items = "";
      while (t < now) {
        const end = Math.min(Math.floor(t / H) * H + H, now);
        const ok = hasRec(S.cam, t);
        const key = "r" + t;
        items += `<button class="pb-item${S.clipKey === key ? " active" : ""}" data-r="${t}" ${ok ? "" : "disabled"}>
          <span><b>${fmtHM(t)} &ndash; ${fmtHM(end)}</b><small>${ok ? "Continuous recording" : "No recording (camera offline)"}</small></span>
          <span class="tag">${ok ? "Play" : "Gap"}</span></button>`;
        t = end;
      }
      list.innerHTML = items;
    } else {
      const ds = dayStart(S.day);
      $("#pbListTitle").textContent = new Date(ds).toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long" }) + " \u2022 CAM " + pad(S.cam);
      let items = "";
      for (let h = 0; h < 24; h++) {
        const t = ds + h * H, ok = hasRec(S.cam, t), key = "a" + t;
        items += `<button class="pb-item${S.clipKey === key ? " active" : ""}" data-a="${t}" ${ok ? "" : "disabled"}>
          <span><b>${pad(h)}:00 &ndash; ${pad((h + 1) % 24)}:00</b><small>${ok ? clipSize(S.cam, t) + " MB &middot; 1080p" : "No recording"}</small></span>
          <span class="tag">${ok ? "Play" : "Gap"}</span></button>`;
      }
      list.innerHTML = items;
    }
  }
  $("#pbList").addEventListener("click", (e) => {
    const b = e.target.closest(".pb-item"); if (!b || b.disabled) return;
    if (b.dataset.r) {
      const t = Number(b.dataset.r), ws = Date.now() - 5 * H;
      S.start = ws; S.dur = 5 * 3600; S.pos = Math.max(0, (t - ws) / 1000);
      S.clipKey = "r" + t;
    } else {
      const t = Number(b.dataset.a);
      S.start = t; S.dur = 3600; S.pos = 0; S.clipKey = "a" + t;
    }
    S.playing = true;
    renderList(); sync();
  });

  /* ---------- Controls ---------- */
  const slider = $("#pbSlider");
  let dragging = false;
  slider.addEventListener("input", () => { dragging = true; S.pos = Number(slider.value); sync(true); });
  slider.addEventListener("change", () => { dragging = false; });
  $("#pbPlay").addEventListener("click", () => { if (S.pos >= S.dur) S.pos = 0; S.playing = !S.playing; sync(); });
  $("#pbBack").addEventListener("click", () => { S.pos = Math.max(0, S.pos - 10); sync(); });
  $("#pbFwd").addEventListener("click", () => { S.pos = Math.min(S.dur, S.pos + 10); sync(); });
  $("#pbSpeed").addEventListener("change", (e) => { S.speed = Number(e.target.value); });
  $("#pbSnap").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = $("#pbCanvas").toDataURL("image/png");
    a.download = "playback_cam" + pad(S.cam) + "_" + Math.floor(S.start + S.pos * 1000) + ".png";
    a.click();
  });

  function sync(fromSlider) {
    slider.max = S.dur;
    if (!fromSlider) slider.value = S.pos;
    $("#pbT0").textContent = fmtDT(S.start).slice(-8) === "" ? "" : fmtHM(S.start);
    $("#pbT1").textContent = fmtHM(S.start + S.dur * 1000);
    $("#pbNow").textContent = fmtDT(S.start + S.pos * 1000);
    $("#pbPlay").innerHTML = S.playing ? "&#10074;&#10074; Pause" : "&#9654; Play";
  }

  /* ---------- Simulated footage renderer ---------- */
  function draw(ms) {
    const cv = $("#pbCanvas"), ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
    const fs = Math.round(h * 0.055);
    const cam = CAMS[S.cam - 1];
    const label = "CAM " + pad(cam.id) + " \u2022 " + cam.name;

    if (!hasRec(cam.id, ms)) {
      ctx.fillStyle = "#070b14"; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 260; i++) { ctx.fillStyle = "rgba(255,255,255," + (Math.random() * 0.2).toFixed(2) + ")"; ctx.fillRect(Math.random() * w, Math.random() * h, w / 50, h / 80); }
      ctx.textAlign = "center"; ctx.fillStyle = "#f59e0b"; ctx.font = "bold " + fs * 1.5 + "px sans-serif";
      ctx.fillText("NO RECORDING", w / 2, h / 2);
      ctx.font = fs * 0.8 + "px sans-serif"; ctx.fillStyle = "#94a3b8";
      ctx.fillText("No footage stored for this time", w / 2, h / 2 + fs * 1.3);
      ctx.textAlign = "left";
    } else {
      const hue = 190 + (cam.id * 11) % 40;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "hsl(" + hue + ",28%,17%)"); g.addColorStop(1, "hsl(" + hue + ",32%,6%)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      const vx = w / 2, vy = h * 0.42;
      ctx.strokeStyle = "rgba(180,220,240,0.12)"; ctx.lineWidth = 1;
      for (let k = -7; k <= 7; k++) { ctx.beginPath(); ctx.moveTo(vx, vy); ctx.lineTo(vx + k * w * 0.2, h); ctx.stroke(); }
      for (let r = 1; r <= 6; r++) { const y = vy + (h - vy) * Math.pow(r / 6, 2); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      // figures: position depends on footage timestamp (so scrubbing is consistent)
      for (let j = 0; j < 3; j++) {
        const speed = 0.000025 * (1 + j) * (1 + (cam.id % 4) * 0.35);
        const x = (((ms * speed + cam.id * 0.17 + j * 0.31) % 1) * (w + 80)) - 40;
        const y = h * (0.56 + 0.1 * j), s = h * (0.06 + 0.035 * j);
        ctx.fillStyle = "rgba(210,232,244," + (0.22 + 0.08 * j) + ")";
        ctx.beginPath(); ctx.arc(x, y - s * 1.6, s * 0.38, 0, 6.283); ctx.fill();
        ctx.fillRect(x - s * 0.35, y - s * 1.2, s * 0.7, s * 1.6);
      }
      for (let i = 0; i < 40; i++) { ctx.fillStyle = "rgba(255,255,255," + (Math.random() * 0.07).toFixed(2) + ")"; ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
    }

    ctx.font = "bold " + fs + "px sans-serif"; ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "left";
    ctx.fillText(label, w * 0.03, h * 0.09);
    ctx.font = fs * 0.85 + "px monospace"; ctx.fillStyle = "#cbd5e1";
    const d = new Date(ms);
    ctx.fillText(d.toLocaleDateString("en-GB") + " " + d.toLocaleTimeString("en-GB", { hour12: false }), w * 0.03, h * 0.96);
    ctx.fillStyle = "#3b82f6"; ctx.font = "bold " + fs * 0.8 + "px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(S.playing ? "\u25B6 PLAYBACK " + S.speed + "x" : "\u275A\u275A PAUSED", w * 0.97, h * 0.09);
    ctx.textAlign = "left";
  }

  let last = 0;
  function loop(ts) {
    const dt = last ? (ts - last) / 1000 : 0; last = ts;
    if (section.classList.contains("active")) {
      if (S.playing && !dragging) {
        S.pos += dt * S.speed;
        if (S.pos >= S.dur) { S.pos = S.dur; S.playing = false; }
        sync();
      }
      draw(S.start + S.pos * 1000);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  enterRecent();
})();

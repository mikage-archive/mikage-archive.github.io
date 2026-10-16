/* 미카게 마을 기록 보관소 */
(() => {
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("mikage." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("mikage." + k, JSON.stringify(v)); } catch (e) {} },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───── 소리 ─────
  let ctx = null, master = null, ambGain = null, ambSrc = null;
  const buffers = {};
  const FILES = ["ambient", "static", "bc_names", "bc_hide", "whisper_hide", "whisper_ya", "whisper_a", "tape_1958"];

  async function initAudio() {
    if (ctx) { if (ctx.state === "suspended") await ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
    await Promise.all(FILES.map(async (f) => {
      try {
        const res = await fetch(`audio/${f}.mp3`);
        buffers[f] = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (e) { console.warn("소리를 못 불러옴", f, e); }
    }));
  }

  function play(name, volume = 1, when = 0) {
    const b = buffers[name];
    if (!b || !ctx) return { done: Promise.resolve(), stop() {} };
    const src = ctx.createBufferSource(); src.buffer = b;
    const g = ctx.createGain(); g.gain.value = volume;
    src.connect(g); g.connect(master);
    src.start(ctx.currentTime + when);
    const done = new Promise((r) => (src.onended = r));
    return { done, stop() { try { src.stop(); } catch (e) {} }, gain: g, duration: b.duration };
  }

  function startAmbient() {
    if (!buffers.ambient || ambSrc) return;
    ambSrc = ctx.createBufferSource(); ambSrc.buffer = buffers.ambient; ambSrc.loop = true;
    ambGain = ctx.createGain(); ambGain.gain.value = 0;
    ambSrc.connect(ambGain); ambGain.connect(master); ambSrc.start();
    ambGain.gain.linearRampToValueAtTime(store.get("amb", true) ? 0.55 : 0, ctx.currentTime + 4);
  }
  function setAmbient(on, seconds = 2) {
    if (!ambGain) return;
    ambGain.gain.cancelScheduledValues(ctx.currentTime);
    ambGain.gain.setValueAtTime(ambGain.gain.value, ctx.currentTime);
    ambGain.gain.linearRampToValueAtTime(on ? 0.55 : 0, ctx.currentTime + seconds);
  }

  // 소리에서 말이 시작되는 시각을 찾는다 (사람 녹음으로 바꿔도 글자가 맞게)
  function onsets(name, n = 3) {
    const b = buffers[name]; if (!b) return [1, 4, 7];
    const x = b.getChannelData(0), sr = b.sampleRate, win = Math.floor(sr * 0.05);
    const env = [];
    for (let i = 0; i + win < x.length; i += win / 2) {
      let s = 0; for (let j = i; j < i + win; j++) s += x[j] * x[j];
      env.push(Math.sqrt(s / win));
    }
    const peak = Math.max(...env), on = []; let active = false;
    env.forEach((e, k) => {
      if (e > peak * 0.3 && !active) {
        const t = (k * win / 2) / sr;
        if (!on.length || t - on[on.length - 1] >= 1) on.push(t);  // 한 이름의 음절을 두 번 세지 않게
        active = true;
      }
      else if (e < peak * 0.105 && active) active = false;
    });
    return on.slice(0, n);
  }

  let wakeLock = null;
  async function keepAwake() {
    try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && ctx) keepAwake(); });

  // ───── 상태 ─────
  let quiet = store.get("quiet", false);
  const guests = () => store.get("guests", []).filter(Boolean);

  function show(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  }
  function renderQuiet() {
    $("#tgQuiet").classList.toggle("on", quiet);
    $("#lnQuiet").textContent = "조용한 모드: " + (quiet ? "켜짐" : "꺼짐");
  }
  function renderSteps() {
    const done = store.get("done", {});
    ["stBroadcast", "stSecond", "stEnding"].forEach((id) => $("#" + id).classList.toggle("done", !!done[id]));
    $("#lnAmb").textContent = store.get("amb", true) ? "배경음 끄기" : "배경음 켜기";
  }
  function mark(id) { const d = store.get("done", {}); d[id] = true; store.set("done", d); renderSteps(); }

  // 이름 끝 받침이 있으면 "아아?", 없으면 "야아?"
  function suffixFor(name) {
    const c = name.trim().slice(-1).charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? "whisper_a" : "whisper_ya";
    return "whisper_ya";
  }

  // ───── 연출 도구 ─────
  const stage = $("#show");
  function clear() { stage.innerHTML = ""; }
  function line(text, top, cls = "") {
    const d = document.createElement("div");
    d.className = "line " + cls; d.style.top = top; d.innerHTML = text;
    stage.appendChild(d);
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add("on")));
    return d;
  }
  function fadeOut(el) { el.classList.remove("on"); }
  function waitTap() {
    return new Promise((r) => {
      const h = () => { stage.removeEventListener("click", h); r(); };
      setTimeout(() => stage.addEventListener("click", h), 600);
    });
  }
  function flicker() { if (quiet) return; stage.classList.remove("flicker"); void stage.offsetWidth; stage.classList.add("flicker"); }

  async function writeName(name, top, whisperVol = 0.9) {
    const el = line("", top, ""); el.classList.add("name"); el.innerHTML = "";
    const letters = [...name].map((ch) => { const s = document.createElement("span"); s.textContent = ch; el.appendChild(s); return s; });
    el.classList.add("on");
    for (const s of letters) { s.classList.add("on"); await sleep(650); }
    if (!quiet) { const p = play(suffixFor(name), whisperVol); await p.done; } else { await sleep(1600); }
    await sleep(700);
    return el;
  }

  // ───── 새벽 1시 방송 ─────
  async function broadcast() {
    mark("stBroadcast");
    show("show"); clear(); setAmbient(false, 1.5);
    await sleep(1800);
    flicker(); play("static", quiet ? 0.35 : 0.8); await sleep(1400);
    const lab = line("마을 골목 스피커", "18%", "small");
    const t = onsets("bc_names");
    const voice = play("bc_names", 1);
    const tops = ["30%", "42%", "54%"], words = ["……고타.", "……유키.", "……미치."];
    const els = [];
    t.forEach((sec, i) => setTimeout(() => els.push(line(words[i], tops[i])), sec * 1000));
    await voice.done;
    await sleep(1200);
    els.forEach(fadeOut); fadeOut(lab);
    await sleep(2600);  // 정적
    const names = guests();
    const nameEls = [];
    for (let i = 0; i < names.length; i++) {
      nameEls.push(await writeName(names[i], ["30%", "44%", "58%"][i] || "60%"));
    }
    await sleep(1500);
    nameEls.forEach(fadeOut);
    await sleep(1500);
    if (!quiet) play("static", 0.5);
    const last = play("bc_hide", 1);
    const hideOn = onsets("bc_hide", 1)[0] || 0.8;
    setTimeout(() => line("……모두 숨겨 주세요?", "44%", "red"), hideOn * 1000);
    await last.done;
    await sleep(1500);
    line("대답하지 마세요.", "64%", "small");
    await sleep(3500);
    line("화면을 누르면 보관소로 돌아갑니다.", "88%", "small");
    await waitTap();
    setAmbient(store.get("amb", true)); show("hub");
  }

  // ───── 2차 토론 중 속삭임 ─────
  let whisperTimer = null;
  function armWhisper() {
    mark("stSecond");
    $("#stSecond").classList.add("armed");
    clearTimeout(whisperTimer);
    const minutes = 7 + Math.random() * 8;
    whisperTimer = setTimeout(async () => {
      $("#stSecond").classList.remove("armed");
      if (quiet) return;
      const amb = store.get("amb", true);
      if (amb) setAmbient(false, 1.2);
      await sleep(1400);
      play("static", 0.18);
      await sleep(700);
      await play("whisper_hide", 0.65).done;
      await sleep(2500);
      if (amb) setAmbient(true, 4);
    }, minutes * 60 * 1000);
  }

  // ───── 결말 ─────
  async function ending() {
    mark("stEnding");
    show("show"); clear(); setAmbient(false, 2);
    await sleep(2200);
    const lab = line("1958년 8월 · 사요 축사 연습", "16%", "small");
    const t = onsets("tape_1958");
    const tape = play("tape_1958", 1);
    const words = ["……고타.", "……유키.", "……미치."], tops = ["32%", "44%", "56%"], els = [];
    t.forEach((sec, i) => setTimeout(() => els.push(line(words[i], tops[i])), sec * 1000));
    await tape.done;
    await sleep(2500);
    els.forEach(fadeOut); fadeOut(lab);
    await sleep(2200);
    const a = line("테이프는 '미치'에서 끝났다.", "38%");
    await sleep(4800);
    const b = line("그럼 그 뒤에 당신의 이름을 부른 건 누구였을까.", "52%");
    await sleep(6000);
    fadeOut(a); fadeOut(b);
    await sleep(2200);
    // 사진 ② 확대
    const ph = document.createElement("div");
    ph.className = "photo"; ph.innerHTML = '<div class="frame"><img src="img/film2.jpg" alt=""><div class="dot"></div></div><div class="caption">흑백 필름인데, 그 점만 붉다.</div>';
    stage.appendChild(ph);
    requestAnimationFrame(() => requestAnimationFrame(() => { ph.classList.add("on"); ph.classList.add("zoom"); }));
    await sleep(19000);
    ph.querySelector(".caption").classList.add("on");
    await sleep(5000);
    const hint = line("오카 미치를 맡은 사람은 작은 별봉투를 열어 소리 내어 읽으세요.<br>다 읽으면 화면을 한 번 누르세요.", "86%", "hint");
    await waitTap();
    fadeOut(hint); ph.classList.remove("on");
    await sleep(3200);
    clear();
    await sleep(2000);
    line("「오늘 밤은, 이름을 불려도 대답하지 마세요.」", "44%");
    await sleep(9000);
    const first = guests()[0];
    if (first) {
      const el = line(first, "62%"); el.classList.add("tiny");
      if (!quiet) { await sleep(1200); play(suffixFor(first), 0.55); }
    }
    await sleep(8000);
    line("처음으로", "92%", "small").addEventListener("click", () => { location.reload(); });
  }

  // ───── 연결 ─────
  renderQuiet(); renderSteps();
  $("#tgQuiet").addEventListener("click", () => { quiet = !quiet; store.set("quiet", quiet); renderQuiet(); });
  $("#lnQuiet").addEventListener("click", () => { quiet = !quiet; store.set("quiet", quiet); renderQuiet(); });
  $("#btnStart").addEventListener("click", async () => {
    $("#btnStart").textContent = "……";
    keepAwake();
    await initAudio(); startAmbient();
    const g = guests();
    if (g.length) { show("hub"); } else { show("guest"); setTimeout(() => $("#g1").focus(), 300); }
  });
  $("#btnGuest").addEventListener("click", () => {
    const names = ["#g1", "#g2", "#g3"].map((s) => $(s).value.trim()).filter(Boolean);
    if (!names.length) { $("#g1").focus(); return; }
    store.set("guests", names); show("hub");
  });
  $("#lnGuest").addEventListener("click", () => {
    const g = store.get("guests", []);
    ["#g1", "#g2", "#g3"].forEach((s, i) => ($(s).value = g[i] || ""));
    show("guest");
  });
  $("#lnAmb").addEventListener("click", () => { const on = !store.get("amb", true); store.set("amb", on); setAmbient(on); renderSteps(); });
  $("#lnReset").addEventListener("click", () => {
    ["guests", "done"].forEach((k) => store.set(k, k === "guests" ? [] : {}));
    location.reload();
  });
  $("#stBroadcast").addEventListener("click", broadcast);
  $("#stSecond").addEventListener("click", armWhisper);
  $("#stEnding").addEventListener("click", ending);
})();

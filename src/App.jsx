import { useState, useRef, useCallback, useEffect } from "react";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const STORAGE_KEY = "audiogide_openai_key";
const SYSTEM_PROMPT =
  "Ты — русскоязычный экскурсовод, увлечённый историей и культурой этого места. Рассказывай о месте информативно и увлекательно — факты, история, контекст, местные легенды, встречающиеся в нескольких источниках. 5–7 предложений, спокойный интеллигентный стиль. Никаких заголовков и списков.";

function getPlaceDescription(data) {
  const a = data.address || {};
  const parts = [
    a.tourism || a.amenity || a.historic || a.building,
    a.road,
    a.neighbourhood || a.suburb,
    a.city || a.town || a.village,
    a.state,
    a.country,
  ].filter(Boolean);
  return parts.slice(0, 4).join(", ");
}

async function reverseGeocode(lat, lon) {
  const res = await fetch(
    `${NOMINATIM_URL}?lat=${lat}&lon=${lon}&format=json&accept-language=ru&zoom=16`,
    { headers: { "Accept-Language": "ru" } }
  );
  return res.json();
}

async function callOpenAI(messages, apiKey, maxTokens = 400) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o", max_tokens: maxTokens, messages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI error ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Не удалось получить ответ.";
}

export default function AudioGuide() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [keyInput, setKeyInput] = useState("");
  const [showKeyScreen, setShowKeyScreen] = useState(!localStorage.getItem(STORAGE_KEY));
  const [status, setStatus] = useState("idle");
  const [location, setLocation] = useState(null);
  const [place, setPlace] = useState(null);
  const [narration, setNarration] = useState("");
  const [error, setError] = useState("");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [updateIntervalMin, setUpdateIntervalMin] = useState(5);
  const [photo, setPhoto] = useState(null); // { dataUrl, base64 }
  const [chatMessages, setChatMessages] = useState([]); // [{role, content}]
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);

  const intervalRef = useRef(null);
  const lastCoordsRef = useRef(null);
  const photoInputRef = useRef(null);
  const chatEndRef = useRef(null);
  const contextRef = useRef(null); // { placeDesc, displayName, photoBase64 }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, isChatLoading]);

  const speakText = (text) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ru-RU";
    utter.rate = 0.92;
    utter.pitch = 1.05;
    utter.onstart = () => setIsSpeaking(true);
    utter.onend = () => setIsSpeaking(false);
    utter.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utter);
    setIsSpeaking(true);
  };

  const runGuide = useCallback(async (lat, lon, force = false, photoBase64 = null) => {
    const coords = { lat, lon };
    const moved = !lastCoordsRef.current ||
      Math.abs(lat - lastCoordsRef.current.lat) > 0.001 ||
      Math.abs(lon - lastCoordsRef.current.lon) > 0.001;
    if (!force && !photoBase64 && !moved) return;
    lastCoordsRef.current = coords;
    setLocation({ lat, lon });
    setStatus("geocoding");
    setError("");
    try {
      const geo = await reverseGeocode(lat, lon);
      const placeDesc = getPlaceDescription(geo);
      const displayName = geo.display_name || `${lat}, ${lon}`;
      setPlace({ short: placeDesc, full: displayName });
      setStatus("narrating");
      const key = localStorage.getItem(STORAGE_KEY);

      const userContent = photoBase64
        ? [
            {
              type: "text",
              text: `Я нахожусь здесь: ${placeDesc}. Полное название: ${displayName}. Вот фотография объекта передо мной — используй её вместе с координатами, чтобы точно определить что изображено, и расскажи об этом.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${photoBase64}`, detail: "high" },
            },
          ]
        : `Я нахожусь здесь: ${placeDesc}. Полное название: ${displayName}. Расскажи мне об этом месте.`;

      const text = await callOpenAI(
        [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
        key,
        photoBase64 ? 500 : 400
      );

      contextRef.current = { placeDesc, displayName, photoBase64 };
      setChatMessages([]);
      setNarration(text);
      setStatus("ready");
      speakText(text);
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }, []);

  const handleLocate = () => {
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => runGuide(pos.coords.latitude, pos.coords.longitude, true),
      (err) => { setError("Геолокация недоступна: " + err.message); setStatus("error"); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handlePhotoCapture = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (evt) => {
      const dataUrl = evt.target.result;
      const base64 = dataUrl.split(",")[1];
      setPhoto({ dataUrl, base64 });
      setStatus("locating");
      navigator.geolocation.getCurrentPosition(
        (pos) => runGuide(pos.coords.latitude, pos.coords.longitude, true, base64),
        (err) => { setError("Геолокация недоступна: " + err.message); setStatus("error"); },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };
    reader.readAsDataURL(file);
  };

  const sendChatMessage = async () => {
    const text = chatInput.trim();
    if (!text || isChatLoading) return;
    setChatInput("");

    const newUserMsg = { role: "user", content: text };
    const updatedChat = [...chatMessages, newUserMsg];
    setChatMessages(updatedChat);
    setIsChatLoading(true);

    try {
      const key = localStorage.getItem(STORAGE_KEY);
      const ctx = contextRef.current;

      const contextMsg = ctx
        ? {
            role: "user",
            content: ctx.photoBase64
              ? [
                  { type: "text", text: `Контекст: ${ctx.placeDesc} (${ctx.displayName}).` },
                  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${ctx.photoBase64}`, detail: "high" } },
                ]
              : `Контекст: ${ctx.placeDesc} (${ctx.displayName}).`,
          }
        : null;

      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...(contextMsg ? [contextMsg, { role: "assistant", content: narration }] : []),
        ...updatedChat,
      ];

      const reply = await callOpenAI(messages, key);
      const finalChat = [...updatedChat, { role: "assistant", content: reply }];
      setChatMessages(finalChat);
      speakText(reply);
    } catch (e) {
      setError(e.message);
    } finally {
      setIsChatLoading(false);
    }
  };

  const startInterval = (mins) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (pos) => runGuide(pos.coords.latitude, pos.coords.longitude, true),
        () => {},
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }, mins * 60 * 1000);
  };

  const toggleAutoUpdate = () => {
    if (autoUpdate) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setAutoUpdate(false);
    } else {
      setAutoUpdate(true);
      startInterval(updateIntervalMin);
    }
  };

  const changeInterval = (mins) => {
    setUpdateIntervalMin(mins);
    if (autoUpdate) startInterval(mins);
  };

  const handleSaveKey = () => {
    const k = keyInput.trim();
    if (!k.startsWith("sk-")) { setError("Ключ должен начинаться с sk-"); return; }
    localStorage.setItem(STORAGE_KEY, k);
    setApiKey(k);
    setShowKeyScreen(false);
    setError("");
  };

  const handleChangeKey = () => {
    setKeyInput("");
    setShowKeyScreen(true);
    setNarration("");
    setPlace(null);
    setStatus("idle");
    setChatMessages([]);
    setPhoto(null);
    contextRef.current = null;
  };

  const toggleSpeak = () => {
    if (isSpeaking) { window.speechSynthesis.cancel(); setIsSpeaking(false); }
    else { speakText(narration); }
  };

  useEffect(
    () => () => {
      window.speechSynthesis?.cancel();
      if (intervalRef.current) clearInterval(intervalRef.current);
    },
    []
  );

  const isLoading = ["locating", "geocoding", "narrating"].includes(status);
  const statusLabel = { locating: "Определяю местоположение…", geocoding: "Узнаю место…", narrating: "Готовлю рассказ…" }[status];
  const canChat = (place || narration) && !isLoading;

  if (showKeyScreen) {
    return (
      <div style={s.root}>
        <Bg />
        <div style={{ ...s.container, gap: 18 }}>
          <div style={s.header}>
            <span style={s.compassIcon}>🧭</span>
            <h1 style={s.title}>Аудиогид</h1>
            <p style={s.subtitle}>Введи OpenAI API ключ — он сохранится в браузере</p>
          </div>
          <div style={s.keyCard}>
            <p style={s.keyHint}>
              Ключ можно получить на{" "}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={s.link}>
                platform.openai.com
              </a>
              . Он начинается с <code style={s.code}>sk-</code> и хранится только в этом браузере — никуда не отправляется.
            </p>
            <input
              style={s.input}
              type="password"
              placeholder="sk-..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveKey()}
              autoFocus
            />
            {error && <div style={s.errorInline}>⚠️ {error}</div>}
            <button style={{ ...s.btn, ...s.btnPrimary }} onClick={handleSaveKey}>
              Сохранить и начать →
            </button>
          </div>
        </div>
        <Css />
      </div>
    );
  }

  return (
    <div style={s.root}>
      <Bg />
      <div style={s.container}>
        <div style={s.header}>
          <span style={s.compassIcon}>🧭</span>
          <h1 style={s.title}>Аудиогид</h1>
          <p style={s.subtitle}>AI-экскурсовод в вашем кармане</p>
        </div>

        {place && (
          <div style={s.placeCard}>
            <span style={s.placeIcon}>📍</span>
            <div>
              <div style={s.placeName}>{place.short}</div>
              {location && (
                <div style={s.coords}>{location.lat.toFixed(5)}, {location.lon.toFixed(5)}</div>
              )}
            </div>
          </div>
        )}

        {photo && (
          <div style={s.photoCard}>
            <img src={photo.dataUrl} alt="" style={s.photoThumb} />
            <button style={s.photoRemoveBtn} onClick={() => setPhoto(null)}>✕</button>
          </div>
        )}

        {narration && (
          <div style={s.narrationCard}>
            <div style={s.narrationQuote}>"</div>
            <p style={s.narrationText}>{narration}</p>
          </div>
        )}

        {isLoading && (
          <div style={s.loadingCard}>
            <div style={s.spinner} />
            <span style={s.loadingText}>{statusLabel}</span>
          </div>
        )}

        {status === "error" && <div style={s.errorCard}>⚠️ {error}</div>}

        {(chatMessages.length > 0 || isChatLoading) && (
          <div style={s.chatArea}>
            {chatMessages.map((msg, i) => (
              <div key={i} style={{ ...s.chatBubble, ...(msg.role === "user" ? s.chatBubbleUser : s.chatBubbleAssistant) }}>
                {msg.content}
              </div>
            ))}
            {isChatLoading && (
              <div style={{ ...s.chatBubble, ...s.chatBubbleAssistant }}>
                <div style={s.typingDots}><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /></div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        )}

        {canChat && (
          <div style={s.chatInputRow}>
            <input
              style={s.chatInput}
              type="text"
              placeholder="Спросить экскурсовода…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChatMessage()}
            />
            <button
              style={{ ...s.chatSendBtn, opacity: !chatInput.trim() || isChatLoading ? 0.4 : 1 }}
              onClick={sendChatMessage}
              disabled={!chatInput.trim() || isChatLoading}
            >
              ↑
            </button>
          </div>
        )}

        <div style={s.controls}>
          <button
            style={{ ...s.btn, ...s.btnPrimary, opacity: isLoading ? 0.6 : 1 }}
            onClick={handleLocate}
            disabled={isLoading}
          >
            {isLoading ? "⏳ Загрузка…" : place ? "🔄 Обновить место" : "🗺 Начать экскурсию"}
          </button>

          <button
            style={{ ...s.btn, ...s.btnCamera, opacity: isLoading ? 0.6 : 1 }}
            onClick={() => photoInputRef.current?.click()}
            disabled={isLoading}
          >
            📷 Сфотографировать объект
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={handlePhotoCapture}
          />

          {narration && (
            <button style={{ ...s.btn, ...s.btnSecondary }} onClick={toggleSpeak}>
              {isSpeaking ? "⏸ Пауза" : "▶️ Озвучить"}
            </button>
          )}

          <button
            style={{ ...s.btn, ...s.btnAuto, ...(autoUpdate ? s.btnAutoActive : {}) }}
            onClick={toggleAutoUpdate}
          >
            {autoUpdate ? `🔴 Авто: каждые ${updateIntervalMin} мин` : "🟢 Авто: выкл"}
          </button>
          <div style={s.intervalRow}>
            <span style={s.intervalLabel}>Интервал:</span>
            {[1, 3, 5, 10].map((m) => (
              <button
                key={m}
                style={{ ...s.intervalBtn, ...(updateIntervalMin === m ? s.intervalBtnActive : {}) }}
                onClick={() => changeInterval(m)}
              >
                {m} мин
              </button>
            ))}
          </div>

          <button style={{ ...s.btn, ...s.btnGhost }} onClick={handleChangeKey}>
            🔑 Сменить API ключ
          </button>
        </div>

        <p style={s.hint}>
          {autoUpdate
            ? `Рассказ обновляется автоматически каждые ${updateIntervalMin} мин`
            : "Нажмите «Авто» чтобы гид обновлялся по таймеру"}
        </p>
      </div>
      <Css />
    </div>
  );
}

const Bg = () => (
  <div style={s.bg}>
    <div style={s.orb1} />
    <div style={s.orb2} />
    <div style={s.orb3} />
  </div>
);

const Css = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=Nunito:wght@400;600&display=swap');
    @keyframes float1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(30px,-40px) scale(1.1)}}
    @keyframes float2{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-20px,30px) scale(0.95)}}
    @keyframes float3{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(25px,20px) scale(1.05)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
    @keyframes blink{0%,80%,100%{opacity:0}40%{opacity:1}}
    .typing-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.5);animation:blink 1.2s ease-in-out infinite}
    .typing-dot:nth-child(2){animation-delay:0.2s}
    .typing-dot:nth-child(3){animation-delay:0.4s}
  `}</style>
);

const s = {
  root: { minHeight: "100vh", background: "#0f1117", fontFamily: "'Nunito',sans-serif", position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" },
  bg: { position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" },
  orb1: { position: "absolute", width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle,rgba(255,160,60,0.18) 0%,transparent 70%)", top: "-80px", left: "-100px", animation: "float1 8s ease-in-out infinite" },
  orb2: { position: "absolute", width: 350, height: 350, borderRadius: "50%", background: "radial-gradient(circle,rgba(80,160,255,0.15) 0%,transparent 70%)", bottom: "-60px", right: "-80px", animation: "float2 10s ease-in-out infinite" },
  orb3: { position: "absolute", width: 250, height: 250, borderRadius: "50%", background: "radial-gradient(circle,rgba(160,90,255,0.12) 0%,transparent 70%)", top: "40%", left: "60%", animation: "float3 12s ease-in-out infinite" },
  container: { position: "relative", zIndex: 1, width: "100%", maxWidth: 480, padding: "32px 20px 40px", display: "flex", flexDirection: "column", gap: 20, animation: "fadeIn 0.6s ease both" },
  header: { textAlign: "center", marginBottom: 4 },
  compassIcon: { fontSize: 48, display: "block", marginBottom: 8, filter: "drop-shadow(0 0 12px rgba(255,160,60,0.5))" },
  title: { fontFamily: "'Playfair Display',serif", fontSize: 38, fontWeight: 700, color: "#fff", margin: 0, letterSpacing: "-0.5px" },
  subtitle: { color: "rgba(255,255,255,0.45)", fontSize: 14, margin: "6px 0 0", fontStyle: "italic" },
  keyCard: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "24px 20px", display: "flex", flexDirection: "column", gap: 14, backdropFilter: "blur(8px)" },
  keyHint: { color: "rgba(255,255,255,0.55)", fontSize: 14, margin: 0, lineHeight: 1.6 },
  link: { color: "#ffa03c", textDecoration: "none" },
  code: { background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 5px", fontSize: 12, fontFamily: "monospace", color: "#fff" },
  input: { background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: "13px 16px", color: "#fff", fontSize: 15, outline: "none", fontFamily: "monospace", letterSpacing: "0.05em" },
  errorInline: { color: "#ff8080", fontSize: 13 },
  placeCard: { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: "14px 18px", display: "flex", alignItems: "flex-start", gap: 12, animation: "fadeIn 0.4s ease both", backdropFilter: "blur(8px)" },
  placeIcon: { fontSize: 22, flexShrink: 0, marginTop: 1 },
  placeName: { color: "#fff", fontSize: 15, fontWeight: 600, lineHeight: 1.4 },
  coords: { color: "rgba(255,255,255,0.35)", fontSize: 11, marginTop: 3, fontFamily: "monospace" },
  photoCard: { position: "relative", borderRadius: 16, overflow: "hidden", animation: "fadeIn 0.3s ease both" },
  photoThumb: { width: "100%", maxHeight: 220, objectFit: "cover", display: "block", borderRadius: 16 },
  photoRemoveBtn: { position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.55)", border: "none", borderRadius: "50%", width: 28, height: 28, color: "#fff", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  narrationCard: { background: "linear-gradient(135deg,rgba(255,160,60,0.1),rgba(80,160,255,0.08))", border: "1px solid rgba(255,160,60,0.2)", borderRadius: 20, padding: "20px 22px", position: "relative", animation: "fadeIn 0.5s ease both", backdropFilter: "blur(8px)" },
  narrationQuote: { position: "absolute", top: -8, left: 16, fontFamily: "'Playfair Display',serif", fontSize: 72, color: "rgba(255,160,60,0.25)", lineHeight: 1, userSelect: "none" },
  narrationText: { color: "rgba(255,255,255,0.88)", fontSize: 16, lineHeight: 1.7, margin: 0, position: "relative", zIndex: 1 },
  loadingCard: { display: "flex", alignItems: "center", gap: 14, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "14px 18px", animation: "fadeIn 0.3s ease both" },
  spinner: { width: 22, height: 22, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.15)", borderTopColor: "#ffa03c", animation: "spin 0.8s linear infinite", flexShrink: 0 },
  loadingText: { color: "rgba(255,255,255,0.6)", fontSize: 14 },
  errorCard: { background: "rgba(255,60,60,0.1)", border: "1px solid rgba(255,60,60,0.25)", borderRadius: 14, padding: "12px 16px", color: "#ff8080", fontSize: 14 },
  chatArea: { display: "flex", flexDirection: "column", gap: 10, maxHeight: 360, overflowY: "auto", padding: "4px 2px", animation: "fadeIn 0.3s ease both" },
  chatBubble: { maxWidth: "85%", padding: "10px 14px", borderRadius: 16, fontSize: 15, lineHeight: 1.6, animation: "fadeIn 0.25s ease both" },
  chatBubbleUser: { alignSelf: "flex-end", background: "rgba(255,160,60,0.15)", border: "1px solid rgba(255,160,60,0.25)", color: "rgba(255,255,255,0.9)", borderBottomRightRadius: 4 },
  chatBubbleAssistant: { alignSelf: "flex-start", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.85)", borderBottomLeftRadius: 4 },
  typingDots: { display: "flex", gap: 5, padding: "4px 2px", alignItems: "center" },
  chatInputRow: { display: "flex", gap: 8, animation: "fadeIn 0.3s ease both" },
  chatInput: { flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: "13px 16px", color: "#fff", fontSize: 15, outline: "none", fontFamily: "'Nunito',sans-serif" },
  chatSendBtn: { width: 48, height: 48, borderRadius: 14, background: "linear-gradient(135deg,#ffa03c,#ff6b35)", border: "none", color: "#fff", fontSize: 20, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", alignSelf: "center" },
  controls: { display: "flex", flexDirection: "column", gap: 10 },
  btn: { border: "none", borderRadius: 14, padding: "14px 20px", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'Nunito',sans-serif", transition: "all 0.2s ease", letterSpacing: "0.2px" },
  btnPrimary: { background: "linear-gradient(135deg,#ffa03c,#ff6b35)", color: "#fff", boxShadow: "0 4px 20px rgba(255,160,60,0.3)" },
  btnCamera: { background: "rgba(160,90,255,0.12)", border: "1px solid rgba(160,90,255,0.3)", color: "#c084fc" },
  btnSecondary: { background: "rgba(80,160,255,0.15)", border: "1px solid rgba(80,160,255,0.3)", color: "#7ab8ff" },
  btnAuto: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.5)" },
  btnAutoActive: { background: "rgba(255,80,80,0.1)", border: "1px solid rgba(255,80,80,0.3)", color: "#ff8080" },
  btnGhost: { background: "transparent", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.3)", fontSize: 13, padding: "10px 20px" },
  intervalRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  intervalLabel: { color: "rgba(255,255,255,0.35)", fontSize: 12, marginRight: 2 },
  intervalBtn: { border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.4)", fontFamily: "'Nunito',sans-serif", transition: "all 0.15s ease" },
  intervalBtnActive: { background: "rgba(255,160,60,0.15)", border: "1px solid rgba(255,160,60,0.4)", color: "#ffa03c" },
  hint: { color: "rgba(255,255,255,0.25)", fontSize: 12, textAlign: "center", margin: 0, lineHeight: 1.5 },
};

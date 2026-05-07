import { useState, useEffect, useRef, useCallback } from "react";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const STORAGE_KEY = "audiogide_openai_key";

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

async function getGuideNarration(placeDescription, displayName, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "Ты — харизматичный русскоязычный экскурсовод. Рассказывай о местах живо, интересно и кратко — как будто идёшь рядом с туристом. Используй 3–5 предложений. Упоминай интересные факты, историю, атмосферу. Никаких заголовков и списков — только живой разговорный текст.",
        },
        {
          role: "user",
          content: `Я сейчас нахожусь здесь: ${placeDescription}. Полное название: ${displayName}. Расскажи мне об этом месте как экскурсовод.`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI error ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Не удалось получить рассказ.";
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
  const watchIdRef = useRef(null);
  const lastCoordsRef = useRef(null);

  const distanceMoved = (a, b) => {
    if (!a || !b) return Infinity;
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const x =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) *
        Math.cos((b.lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  };

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

  const runGuide = useCallback(async (lat, lon, force = false) => {
    const coords = { lat, lon };
    if (!force && distanceMoved(lastCoordsRef.current, coords) < 100) return;
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
      const text = await getGuideNarration(placeDesc, displayName, key);
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

  const toggleAutoUpdate = () => {
    if (autoUpdate) {
      if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current);
      setAutoUpdate(false);
    } else {
      setAutoUpdate(true);
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => runGuide(pos.coords.latitude, pos.coords.longitude),
        () => {},
        { enableHighAccuracy: true }
      );
    }
  };

  const handleSaveKey = () => {
    const k = keyInput.trim();
    if (!k.startsWith("sk-")) {
      setError("Ключ должен начинаться с sk-");
      return;
    }
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
  };

  const toggleSpeak = () => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    } else {
      speakText(narration);
    }
  };

  useEffect(() => () => {
    window.speechSynthesis?.cancel();
    if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current);
  }, []);

  const isLoading = ["locating", "geocoding", "narrating"].includes(status);
  const statusLabel = { locating: "Определяю местоположение…", geocoding: "Узнаю место…", narrating: "Готовлю рассказ…" }[status];

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
              {location && <div style={s.coords}>{location.lat.toFixed(5)}, {location.lon.toFixed(5)}</div>}
            </div>
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

        <div style={s.controls}>
          <button style={{ ...s.btn, ...s.btnPrimary, opacity: isLoading ? 0.6 : 1 }} onClick={handleLocate} disabled={isLoading}>
            {isLoading ? "⏳ Загрузка…" : place ? "🔄 Обновить место" : "🗺 Начать экскурсию"}
          </button>
          {narration && (
            <button style={{ ...s.btn, ...s.btnSecondary }} onClick={toggleSpeak}>
              {isSpeaking ? "⏸ Пауза" : "▶️ Озвучить"}
            </button>
          )}
          <button style={{ ...s.btn, ...s.btnAuto, ...(autoUpdate ? s.btnAutoActive : {}) }} onClick={toggleAutoUpdate}>
            {autoUpdate ? "🔴 Авто: вкл" : "🟢 Авто: выкл"}
          </button>
          <button style={{ ...s.btn, ...s.btnGhost }} onClick={handleChangeKey}>
            🔑 Сменить API ключ
          </button>
        </div>

        <p style={s.hint}>
          {autoUpdate ? "Рассказ обновится автоматически при перемещении на 100м+" : "Нажмите «Авто» чтобы гид обновлялся при движении"}
        </p>
      </div>
      <Css />
    </div>
  );
}

const Bg = () => (
  <div style={s.bg}>
    <div style={s.orb1} /><div style={s.orb2} /><div style={s.orb3} />
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
  `}</style>
);

const s = {
  root:{minHeight:"100vh",background:"#0f1117",fontFamily:"'Nunito',sans-serif",position:"relative",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"},
  bg:{position:"absolute",inset:0,zIndex:0,pointerEvents:"none"},
  orb1:{position:"absolute",width:400,height:400,borderRadius:"50%",background:"radial-gradient(circle,rgba(255,160,60,0.18) 0%,transparent 70%)",top:"-80px",left:"-100px",animation:"float1 8s ease-in-out infinite"},
  orb2:{position:"absolute",width:350,height:350,borderRadius:"50%",background:"radial-gradient(circle,rgba(80,160,255,0.15) 0%,transparent 70%)",bottom:"-60px",right:"-80px",animation:"float2 10s ease-in-out infinite"},
  orb3:{position:"absolute",width:250,height:250,borderRadius:"50%",background:"radial-gradient(circle,rgba(160,90,255,0.12) 0%,transparent 70%)",top:"40%",left:"60%",animation:"float3 12s ease-in-out infinite"},
  container:{position:"relative",zIndex:1,width:"100%",maxWidth:480,padding:"32px 20px 40px",display:"flex",flexDirection:"column",gap:20,animation:"fadeIn 0.6s ease both"},
  header:{textAlign:"center",marginBottom:4},
  compassIcon:{fontSize:48,display:"block",marginBottom:8,filter:"drop-shadow(0 0 12px rgba(255,160,60,0.5))"},
  title:{fontFamily:"'Playfair Display',serif",fontSize:38,fontWeight:700,color:"#fff",margin:0,letterSpacing:"-0.5px"},
  subtitle:{color:"rgba(255,255,255,0.45)",fontSize:14,margin:"6px 0 0",fontStyle:"italic"},
  keyCard:{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:20,padding:"24px 20px",display:"flex",flexDirection:"column",gap:14,backdropFilter:"blur(8px)"},
  keyHint:{color:"rgba(255,255,255,0.55)",fontSize:14,margin:0,lineHeight:1.6},
  link:{color:"#ffa03c",textDecoration:"none"},
  code:{background:"rgba(255,255,255,0.1)",borderRadius:4,padding:"1px 5px",fontSize:12,fontFamily:"monospace",color:"#fff"},
  input:{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:12,padding:"13px 16px",color:"#fff",fontSize:15,outline:"none",fontFamily:"monospace",letterSpacing:"0.05em"},
  errorInline:{color:"#ff8080",fontSize:13},
  placeCard:{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:16,padding:"14px 18px",display:"flex",alignItems:"flex-start",gap:12,animation:"fadeIn 0.4s ease both",backdropFilter:"blur(8px)"},
  placeIcon:{fontSize:22,flexShrink:0,marginTop:1},
  placeName:{color:"#fff",fontSize:15,fontWeight:600,lineHeight:1.4},
  coords:{color:"rgba(255,255,255,0.35)",fontSize:11,marginTop:3,fontFamily:"monospace"},
  narrationCard:{background:"linear-gradient(135deg,rgba(255,160,60,0.1),rgba(80,160,255,0.08))",border:"1px solid rgba(255,160,60,0.2)",borderRadius:20,padding:"20px 22px",position:"relative",animation:"fadeIn 0.5s ease both",backdropFilter:"blur(8px)"},
  narrationQuote:{position:"absolute",top:-8,left:16,fontFamily:"'Playfair Display',serif",fontSize:72,color:"rgba(255,160,60,0.25)",lineHeight:1,userSelect:"none"},
  narrationText:{color:"rgba(255,255,255,0.88)",fontSize:16,lineHeight:1.7,margin:0,position:"relative",zIndex:1},
  loadingCard:{display:"flex",alignItems:"center",gap:14,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:14,padding:"14px 18px",animation:"fadeIn 0.3s ease both"},
  spinner:{width:22,height:22,borderRadius:"50%",border:"2px solid rgba(255,255,255,0.15)",borderTopColor:"#ffa03c",animation:"spin 0.8s linear infinite",flexShrink:0},
  loadingText:{color:"rgba(255,255,255,0.6)",fontSize:14},
  errorCard:{background:"rgba(255,60,60,0.1)",border:"1px solid rgba(255,60,60,0.25)",borderRadius:14,padding:"12px 16px",color:"#ff8080",fontSize:14},
  controls:{display:"flex",flexDirection:"column",gap:10},
  btn:{border:"none",borderRadius:14,padding:"14px 20px",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:"'Nunito',sans-serif",transition:"all 0.2s ease",letterSpacing:"0.2px"},
  btnPrimary:{background:"linear-gradient(135deg,#ffa03c,#ff6b35)",color:"#fff",boxShadow:"0 4px 20px rgba(255,160,60,0.3)"},
  btnSecondary:{background:"rgba(80,160,255,0.15)",border:"1px solid rgba(80,160,255,0.3)",color:"#7ab8ff"},
  btnAuto:{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.5)"},
  btnAutoActive:{background:"rgba(255,80,80,0.1)",border:"1px solid rgba(255,80,80,0.3)",color:"#ff8080"},
  btnGhost:{background:"transparent",border:"1px solid rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.3)",fontSize:13,padding:"10px 20px"},
  hint:{color:"rgba(255,255,255,0.25)",fontSize:12,textAlign:"center",margin:0,lineHeight:1.5},
};
